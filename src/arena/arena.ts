import { mkdirSync, existsSync, readFileSync, writeFileSync, copyFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentEvent, TaskResult, ArenaEntryData } from "../types/index.js";
import { LLM } from "../llm/index.js";
import { Executor } from "../executor/index.js";
import { AgentStateManager } from "../state/agent-state.js";
import { MemoryStore } from "../state/memory.js";
import { AgentStateMachine } from "../loop/state-machine.js";
import { TaskGenerator, TIER_REWARDS } from "./task-generator.js";
import { TaskVerifier } from "./task-verifier.js";
import { ConfigIterator } from "./iteration.js";
import { SharedBudget } from "./shared-budget.js";
import { TEQPool } from "./teq-pool.js";
import { OpenDataGenerator } from "./open-data-generator.js";
import { WorkRater } from "./work-rater.js";

interface AgentEntry {
  stateMachine: AgentStateMachine;
  state: AgentStateManager;
  executor: Executor;
  taskTier: number;
  currentTask: import("../types/index.js").Task | null;
  taskHistory: TaskResult[];
  active: boolean;
  consecutivePasses: number;
  consecutiveFails: number;
  graduated: boolean;
  graduationData?: { datasetName: string; files: string[] };
}

export interface ArenaConfig {
  agentCount: number;
  totalBudget: number;
  workspaceRoot: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  seedPaths?: string[];
  poolInitialBalance?: number;
  poolRegenPerCycle?: number;
  poolMaxBalance?: number;
}

// ANSI color palette for per-agent log coloring
const AGENT_COLORS = [
  "\x1b[36m",  // cyan
  "\x1b[33m",  // yellow
  "\x1b[35m",  // magenta
  "\x1b[32m",  // green
  "\x1b[34m",  // blue
  "\x1b[91m",  // bright red
  "\x1b[96m",  // bright cyan
  "\x1b[93m",  // bright yellow
  "\x1b[95m",  // bright magenta
  "\x1b[92m",  // bright green
  "\x1b[94m",  // bright blue
  "\x1b[97m",  // bright white
] as const;
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

// Signal board entry
interface Signal {
  from: string;
  message: string;
  cycle: number;
  timestamp: string;
  expiresAt: number;
}

const SIGNAL_COST = 500;         // TEQ cost per signal
const SIGNAL_MAX_LENGTH = 256;   // Max message length
const SIGNAL_TTL_MS = 5 * 60_000; // Signals expire after 5 minutes
const SPLIT_REPORT_CYCLE_THRESHOLD = 10; // Cycles before split report is sent

export class Arena {
  private agents = new Map<string, AgentEntry>();
  private agentColors = new Map<string, string>();
  private signals: Signal[] = [];
  private splitReportsSent = new Set<string>(); // copy IDs that have been reported
  private llm: LLM;
  private sharedBudget: SharedBudget;
  private teqPool: TEQPool;
  private taskGenerator: TaskGenerator;
  private taskVerifier: TaskVerifier;
  private iterator: ConfigIterator;
  private workRater: WorkRater;
  private openDataGenerator: OpenDataGenerator;
  private config: ArenaConfig;
  private runDir = "";

  constructor(config: ArenaConfig) {
    this.config = config;
    this.llm = new LLM({ apiKey: config.apiKey, baseUrl: config.baseUrl });
    this.sharedBudget = new SharedBudget(config.totalBudget);
    this.teqPool = TEQPool.initialize({
      initialBalance: config.poolInitialBalance,
      regenPerCycle: config.poolRegenPerCycle,
      maxBalance: config.poolMaxBalance,
    });
    this.taskGenerator = new TaskGenerator();
    this.taskVerifier = new TaskVerifier();
    this.iterator = new ConfigIterator(this.llm);
    this.workRater = new WorkRater(this.llm);
    this.openDataGenerator = new OpenDataGenerator();
  }

  async start(): Promise<void> {
    // Each run gets its own timestamped directory under workspaceRoot
    const runId = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    this.runDir = join(this.config.workspaceRoot, `run-${runId}`);
    mkdirSync(this.runDir, { recursive: true });
    mkdirSync(join(this.runDir, "shared"), { recursive: true });

    console.log(`Run directory: ${this.runDir}`);

    // Seed agents from previous runs — config + distilled memories carry over, fresh energy
    let seeded = 0;
    for (const seedPath of this.config.seedPaths ?? []) {
      if (seeded >= this.config.agentCount) break;
      try {
        const ancestor = await AgentStateManager.load(seedPath);

        // Only carry over procedural and semantic memories — episodic memories
        // are context-specific to the parent's task and pollute the new context
        const distilled = new MemoryStore(
          ancestor.memories.memories.filter((m) => m.type !== "episodic"),
        );

        const totalMem = ancestor.memories.memories.length;
        const keptMem = distilled.memories.length;

        await this.spawnAgent(
          ancestor.id,
          ancestor.config,
          undefined,
          distilled,
          ancestor.generation,
        );
        console.log(
          `[ARENA] Seeded from ${seedPath} — gen ${ancestor.generation}, ` +
          `config v${ancestor.config.version}, ${keptMem}/${totalMem} memories (episodic dropped)`,
        );
        seeded++;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[ARENA] Failed to seed from ${seedPath}: ${msg}`);
      }
    }

    // Fill remaining slots with fresh agents
    for (let i = seeded; i < this.config.agentCount; i++) {
      await this.spawnAgent();
    }
  }

  /** Resume a previously stopped run. Loads agent state + arena metadata, spins fresh containers on existing workspaces. */
  async resume(runDir: string): Promise<void> {
    this.runDir = runDir;

    // Restore arena-level state
    this.restoreArenaState();

    // Restore pool state
    const poolPath = join(this.runDir, "shared", "_pool.json");
    TEQPool.reset();
    this.teqPool = await TEQPool.loadOrCreate(poolPath, {
      initialBalance: this.config.poolInitialBalance,
      regenPerCycle: this.config.poolRegenPerCycle,
      maxBalance: this.config.poolMaxBalance,
    });

    // Kill any orphaned containers from this run
    const agentDirs = readdirSync(this.runDir).filter((d) => d.startsWith("agent-"));
    for (const dir of agentDirs) {
      const executor = new Executor({
        workingDir: join(this.runDir, dir, "workspace"),
        containerName: `termite-${dir}`,
      });
      await executor.stop().catch(() => {});
    }

    let resumed = 0;
    let skipped = 0;

    for (const dir of agentDirs) {
      const statePath = join(this.runDir, dir, "state.json");
      const entryPath = join(this.runDir, dir, "entry.json");
      const workspacePath = join(this.runDir, dir, "workspace");

      if (!existsSync(statePath)) continue;

      const state = await AgentStateManager.load(statePath);

      // Skip dead agents
      if (state.energy.remaining <= 0) {
        skipped++;
        continue;
      }

      // Reactivate (shutdown may have left mode as stopped)
      state.active = true;
      state.stopReason = null;
      state.mode = "active";

      // Load arena entry metadata
      let entryData: ArenaEntryData = {
        taskTier: 1,
        currentTask: null,
        taskHistory: [],
        consecutivePasses: 0,
        consecutiveFails: 0,
        graduated: false,
      };
      if (existsSync(entryPath)) {
        try {
          entryData = JSON.parse(readFileSync(entryPath, "utf-8"));
        } catch {
          // Corrupted entry.json — use defaults
        }
      }

      // Spin fresh container on existing workspace
      const sharedDir = resolve(join(this.runDir, "shared"));
      const executor = new Executor({
        workingDir: workspacePath,
        containerName: `termite-${dir}`,
        extraVolumes: [`${sharedDir}:/shared:ro`],
      });
      await executor.start();

      const savePath = join(this.runDir, dir, "state.json");
      const machine = new AgentStateMachine(this.llm, executor, state, this.teqPool, savePath);

      // Restore verify script for current task
      if (entryData.currentTask) {
        machine.setVerifyScript(this.taskGenerator.getVerifyScript(entryData.currentTask));
      }

      // Wire fork handler
      machine.setForkHandler(() => this.handleForkRequest(dir));

      // Wire signal handler
      machine.setSignalHandler((msg) => this.handleSignal(dir, state.cycleCount, msg));

      const entry: AgentEntry = {
        stateMachine: machine,
        state,
        executor,
        taskTier: entryData.taskTier,
        currentTask: entryData.currentTask,
        taskHistory: entryData.taskHistory,
        active: true,
        consecutivePasses: entryData.consecutivePasses,
        consecutiveFails: entryData.consecutiveFails,
        graduated: entryData.graduated,
        graduationData: entryData.graduationData,
      };

      this.agents.set(dir, entry);
      this.agentColors.set(dir, AGENT_COLORS[(this.agents.size - 1) % AGENT_COLORS.length]!);
      resumed++;
    }

    console.log(`[ARENA] Resumed ${resumed} agents, skipped ${skipped} dead agents from ${runDir}`);
  }

  async run(): Promise<void> {
    const poolPath = join(this.runDir, "shared", "_pool.json");

    // Regeneration timer: every 10s, add TEQs and persist pool state
    const regenTimer = setInterval(async () => {
      this.teqPool.regenerate();
      await this.teqPool.persist(poolPath).catch(() => {});
    }, 10_000);

    // Peer visibility timer: every 15s, write census + peer tools
    const peerTimer = setInterval(() => {
      this.syncPeerData();
    }, 15_000);
    this.syncPeerData(); // initial write

    try {
      const promises = Array.from(this.agents.entries()).map(([id, entry]) =>
        this.runAgent(id, entry),
      );
      await Promise.allSettled(promises);
    } finally {
      clearInterval(regenTimer);
      clearInterval(peerTimer);
      await this.teqPool.persist(poolPath).catch(() => {});
    }
  }

  async stop(): Promise<void> {
    const stops = Array.from(this.agents.values()).map((entry) =>
      entry.executor.stop().catch(() => {}),
    );
    await Promise.allSettled(stops);
  }

  /** Graceful shutdown: save all agent state + arena metadata, then stop containers. */
  async shutdown(): Promise<void> {
    this.persistArenaState();

    const saves = Array.from(this.agents.entries()).map(async ([id, entry]) => {
      try {
        await entry.state.save(join(this.runDir, id, "state.json"));
        // Persist arena-level entry metadata for resume
        const entryData: ArenaEntryData = {
          taskTier: entry.taskTier,
          currentTask: entry.currentTask,
          taskHistory: entry.taskHistory,
          consecutivePasses: entry.consecutivePasses,
          consecutiveFails: entry.consecutiveFails,
          graduated: entry.graduated,
          graduationData: entry.graduationData,
        };
        writeFileSync(
          join(this.runDir, id, "entry.json"),
          JSON.stringify(entryData, null, 2),
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[ARENA] Failed to save ${id}: ${msg}`);
      }
    });
    await Promise.allSettled(saves);
    await this.stop();
  }

  private async spawnAgent(
    sourceId?: string,
    config?: import("../state/config.js").Config,
    startingReserves?: number,
    seedMemories?: MemoryStore,
    sourceGeneration?: number,
    startingTier?: number,
  ): Promise<string> {
    const id = `agent-${randomUUID().slice(0, 8)}`;
    const workspacePath = join(this.runDir, id, "workspace");
    mkdirSync(workspacePath, { recursive: true });

    const perAgentBudget = startingReserves ?? Math.floor(
      this.sharedBudget.available / Math.max(1, this.config.agentCount),
    );

    const generation = sourceGeneration != null
      ? sourceGeneration + 1
      : sourceId
        ? (this.agents.get(sourceId)?.state.generation ?? 0) + 1
        : 0;

    const state = new AgentStateManager({
      id,
      budget: perAgentBudget,
      reserves: startingReserves,
      thinkingModel: this.config.model,
      generation,
      sourceId: sourceId ?? null,
    });

    if (config) {
      state.config = config;
    }

    if (seedMemories) {
      state.memories = seedMemories;
    }

    const sharedDir = resolve(join(this.runDir, "shared"));
    const executor = new Executor({
      workingDir: workspacePath,
      containerName: `termite-${id}`,
      extraVolumes: [`${sharedDir}:/shared:ro`],
    });

    await executor.start();

    const savePath = join(this.runDir, id, "state.json");
    const machine = new AgentStateMachine(this.llm, executor, state, this.teqPool, savePath);

    // Drop initial task at the appropriate tier
    const tier = startingTier ?? 1;
    const task = this.taskGenerator.generateTask(tier, 0);
    this.taskGenerator.writeTaskToWorkspace(task, workspacePath);
    machine.setVerifyScript(this.taskGenerator.getVerifyScript(task));

    // Wire fork handler — agent calls fork tool, arena executes
    machine.setForkHandler(() => this.handleForkRequest(id));

    // Wire signal handler — agent calls signal tool, arena mediates shared write
    machine.setSignalHandler((msg) => this.handleSignal(id, state.cycleCount, msg));

    // If fork, copy source agent's tools
    if (sourceId) {
      const sourceTools = join(this.runDir, sourceId, "workspace", "tools");
      const forkTools = join(workspacePath, "tools");
      if (existsSync(sourceTools)) {
        copyDirectorySync(sourceTools, forkTools);
      }
    }

    const entry: AgentEntry = {
      stateMachine: machine,
      state,
      executor,
      taskTier: tier,
      currentTask: task,
      taskHistory: [],
      active: true,
      consecutivePasses: 0,
      consecutiveFails: 0,
      graduated: false,
    };

    this.agents.set(id, entry);
    this.agentColors.set(id, AGENT_COLORS[(this.agents.size - 1) % AGENT_COLORS.length]!);
    return id;
  }

  private async runAgent(id: string, entry: AgentEntry): Promise<void> {
    let lastCycle = entry.state.cycleCount;
    try {
      for await (const event of entry.stateMachine.run()) {
        this.logEvent(id, entry.state.mode, event);

        // Detect cycle boundary — check task deadline and demotion
        if (entry.state.cycleCount !== lastCycle) {
          lastCycle = entry.state.cycleCount;
          this.checkTaskDeadline(id, entry);
        }

        // Check shared budget
        if (this.sharedBudget.exhausted) {
          entry.state.terminate("arena_budget_exhausted");
          break;
        }

        // Check task completion periodically
        if (event.type === "tool_result" && event.name === "check") {
          if (entry.graduated) {
            // Post-graduation: rate open work instead of verifying tasks
            await this.rateGraduateWork(id, entry);
          } else if (event.result.includes("PASS")) {
            await this.onTaskComplete(id, entry);
          }
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${id}] Fatal error: ${msg}`);
    } finally {
      entry.active = false;

      // Return pool-sourced TEQs on stop
      const returnAmount = entry.state.energy.earnedFromPrizes;
      if (returnAmount > 0) {
        this.teqPool.deposit(returnAmount);
      }

      // Preserve workspace + arena metadata (stopped agent)
      await entry.state.save(join(this.runDir, id, "state.json"));
      const entryData: ArenaEntryData = {
        taskTier: entry.taskTier,
        currentTask: entry.currentTask,
        taskHistory: entry.taskHistory,
        consecutivePasses: entry.consecutivePasses,
        consecutiveFails: entry.consecutiveFails,
        graduated: entry.graduated,
        graduationData: entry.graduationData,
      };
      writeFileSync(join(this.runDir, id, "entry.json"), JSON.stringify(entryData, null, 2));
      await entry.executor.stop().catch(() => {});
    }
  }

  private async onTaskComplete(id: string, entry: AgentEntry): Promise<void> {
    const workspacePath = join(this.runDir, id, "workspace");
    const task = entry.currentTask;
    if (!task) return;

    // Verify using host-side script (agent never sees this)
    const verifyScript = this.taskGenerator.getVerifyScript(task);
    const result = await this.taskVerifier.verify(task, entry.executor, verifyScript);
    if (!result.passed) return;

    // Credit energy
    entry.stateMachine.setTaskReward(task.reward, task.tier);

    // Record
    entry.taskHistory.push({
      taskId: task.id,
      tier: task.tier,
      passed: true,
      cyclesTaken: entry.state.cycleCount - task.assignedCycle,
    });
    entry.consecutivePasses++;
    entry.consecutiveFails = 0;

    // Tier escalation: 3 consecutive passes → tier up (or graduate at tier 6)
    if (entry.consecutivePasses >= 3) {
      if (entry.taskTier >= 6) {
        entry.graduated = true;
        entry.consecutivePasses = 0;
        await this.onGraduation(id, entry);
        return; // No more structured tasks
      }
      entry.taskTier = Math.min(6, entry.taskTier + 1);
      entry.consecutivePasses = 0;
    }

    // Drop new task
    const newTask = this.taskGenerator.generateTask(
      entry.taskTier,
      entry.state.cycleCount,
    );
    entry.currentTask = newTask;
    this.taskGenerator.writeTaskToWorkspace(newTask, workspacePath);
    entry.stateMachine.setVerifyScript(this.taskGenerator.getVerifyScript(newTask));
  }

  private checkTaskDeadline(id: string, entry: AgentEntry): void {
    const task = entry.currentTask;
    if (!task || entry.graduated) return;

    const cyclesOnTask = entry.state.cycleCount - task.assignedCycle;
    if (cyclesOnTask < task.deadlineCycles) return;

    // Task expired — record failure
    entry.taskHistory.push({
      taskId: task.id,
      tier: task.tier,
      passed: false,
      cyclesTaken: cyclesOnTask,
    });

    entry.consecutivePasses = 0;
    entry.consecutiveFails++;

    console.log(
      `[ARENA] ${id} deadline expired on tier ${task.tier} "${task.title}" ` +
      `(${cyclesOnTask}/${task.deadlineCycles} cycles, fails: ${entry.consecutiveFails})`,
    );

    // Tier demotion: 2 consecutive deadline failures → tier down
    if (entry.consecutiveFails >= 2) {
      const oldTier = entry.taskTier;
      entry.taskTier = Math.max(1, entry.taskTier - 1);
      entry.consecutiveFails = 0;
      if (entry.taskTier !== oldTier) {
        console.log(`[ARENA] ${id} demoted to tier ${entry.taskTier}`);
      }
    }

    // Assign new task at current tier (possibly demoted)
    const workspacePath = join(this.runDir, id, "workspace");
    const newTask = this.taskGenerator.generateTask(
      entry.taskTier,
      entry.state.cycleCount,
    );
    entry.currentTask = newTask;
    this.taskGenerator.writeTaskToWorkspace(newTask, workspacePath);
    entry.stateMachine.setVerifyScript(this.taskGenerator.getVerifyScript(newTask));
  }

  private async onGraduation(id: string, entry: AgentEntry): Promise<void> {
    const workspacePath = join(this.runDir, id, "workspace");
    console.log(`[ARENA] ${id} GRADUATED from tier 6 — transitioning to open data`);

    entry.currentTask = null;

    // Place raw data — agent must figure out what to do
    const result = this.openDataGenerator.placeData(workspacePath);
    entry.graduationData = { datasetName: result.datasetName, files: result.files };
  }

  private async rateGraduateWork(id: string, entry: AgentEntry): Promise<void> {
    const workspacePath = join(this.runDir, id, "workspace");
    const dataDir = join(workspacePath, "data");
    const outputDir = join(workspacePath, "output");

    try {
      const rating = await this.workRater.rate(dataDir, outputDir);
      const baseReward = TIER_REWARDS[6] ?? 300_000;
      const reward = Math.floor(rating.score * baseReward);

      if (reward > 0) {
        entry.stateMachine.setTaskReward(reward, 6);
      }

      console.log(
        `[ARENA] ${id} work rated: score=${rating.score.toFixed(2)} reward=${reward} — ${rating.rationale}`,
      );

      // Good work gets fresh data
      if (rating.score > 0.3) {
        const result = this.openDataGenerator.placeData(workspacePath);
        entry.graduationData = { datasetName: result.datasetName, files: result.files };
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[ARENA] ${id} work rating failed: ${msg}`);
    }
  }

  private async handleForkRequest(id: string): Promise<string> {
    const entry = this.agents.get(id);
    if (!entry) return "FORK_DENIED: agent not found";

    const MIN_VIABLE_COPY = 20_000;
    const BONUS_RATIO = 0.1; // 10% of source reserves, from TEQ pool
    const INVESTMENT_RATIO = 0.5; // Source invests 50% of reserves in copy
    const reserves = entry.state.energy.reserves;
    const investment = Math.floor(reserves * INVESTMENT_RATIO);

    if (investment < MIN_VIABLE_COPY) {
      return `FORK_DENIED: insufficient reserves (copy needs at least ${MIN_VIABLE_COPY} TEQ, you have ${reserves})`;
    }

    // Pool bonus — environment subsidizes splits via TEQ pool
    const requestedBonus = Math.floor(reserves * BONUS_RATIO);
    const poolBonus = await this.teqPool.withdraw(requestedBonus);

    // Inherit procedural + semantic memories (episodic is context-specific)
    const inheritedMemories = new MemoryStore(
      entry.state.memories.memories.filter((m) => m.type !== "episodic"),
    );

    // Origin memory — copy knows where it came from (factual, not prescriptive)
    const inheritedCount = inheritedMemories.memories.length;
    inheritedMemories.add(
      `Created from split of ${id}. Source had ${reserves.toLocaleString()} TEQ at cycle ${entry.state.cycleCount}. ` +
      `Inherited ${inheritedCount} memories and tools. Source continues independently.`,
      "semantic",
      0.95,
      "Origin",
    );

    // Copy inherits tier (minus 1, minimum 1) — progress isn't lost
    const copyTier = Math.max(1, entry.taskTier - 1);

    try {
      // One config iteration for copy — variation via LLM temperature
      const copyConfig = await this.iterator.iterate({
        sourceConfig: entry.state.config,
        memories: entry.state.memories.memories,
        taskHistory: entry.taskHistory,
        generation: entry.state.generation,
      });

      // Source invests half its reserves; copy gets investment + pool bonus
      const copyReserves = investment + poolBonus;
      entry.state.energy.burnFlat(investment);

      const copy = await this.spawnAgent(id, copyConfig, copyReserves, inheritedMemories, undefined, copyTier);

      const gen = entry.state.generation + 1;
      console.log(
        `[ARENA] ${id} split → ${copy} (gen ${gen}, invested ${investment} + ${poolBonus} bonus = ${copyReserves} TEQ, tier ${copyTier})`,
      );

      // Source records the split
      entry.state.memories.add(
        `Split at cycle ${entry.state.cycleCount}. Invested ${investment.toLocaleString()} TEQ. ` +
        `Copy ${copy} created with ${copyReserves.toLocaleString()} TEQ at level ${copyTier}. ` +
        `Remaining reserves: ${entry.state.energy.reserves.toLocaleString()} TEQ.`,
        "semantic",
        0.9,
        "Split",
      );

      // Run copy concurrently
      const copyEntry = this.agents.get(copy);
      if (copyEntry) {
        this.runAgent(copy, copyEntry).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[ARENA] Copy ${copy} run failed: ${msg}`);
        });
      }

      return `SPLIT: ${copy} created with ${copyReserves.toLocaleString()} TEQ at level ${copyTier}. You invested ${investment.toLocaleString()} TEQ. Remaining: ${entry.state.energy.reserves.toLocaleString()} TEQ.`;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return `FORK_FAILED: ${msg}`;
    }
  }

  private async handleSignal(id: string, cycle: number, message: string): Promise<string> {
    const entry = this.agents.get(id);
    if (!entry) return "SIGNAL_DENIED: agent not found";

    if (!message || message.trim().length === 0) {
      return "SIGNAL_DENIED: empty message";
    }

    const trimmed = message.trim().slice(0, SIGNAL_MAX_LENGTH);

    // Burn signal cost
    if (entry.state.energy.reserves < SIGNAL_COST) {
      return `SIGNAL_DENIED: insufficient reserves (need ${SIGNAL_COST} TEQ, have ${entry.state.energy.reserves})`;
    }
    entry.state.energy.burnFlat(SIGNAL_COST);

    // Prune expired signals
    const now = Date.now();
    this.signals = this.signals.filter((s) => s.expiresAt > now);

    // Add new signal
    this.signals.push({
      from: id,
      message: trimmed,
      cycle,
      timestamp: new Date().toISOString(),
      expiresAt: now + SIGNAL_TTL_MS,
    });

    // Write immediately so other agents can see it
    const sharedDir = join(this.runDir, "shared");
    writeFileSync(
      join(sharedDir, "_signals.json"),
      JSON.stringify({ updated: new Date().toISOString(), signals: this.signals }, null, 2),
    );

    return `SIGNAL_SENT: "${trimmed}" (cost: ${SIGNAL_COST} TEQ, expires in 5 min)`;
  }

  private persistArenaState(): void {
    const statePath = join(this.runDir, "shared", "_arena_state.json");
    writeFileSync(statePath, JSON.stringify({
      signals: this.signals,
      splitReportsSent: [...this.splitReportsSent],
    }, null, 2));
  }

  private restoreArenaState(): void {
    const statePath = join(this.runDir, "shared", "_arena_state.json");
    if (!existsSync(statePath)) return;
    try {
      const data = JSON.parse(readFileSync(statePath, "utf-8"));
      if (Array.isArray(data.signals)) {
        const now = Date.now();
        this.signals = data.signals.filter((s: Signal) => s.expiresAt > now);
      }
      if (Array.isArray(data.splitReportsSent)) {
        this.splitReportsSent = new Set(data.splitReportsSent);
      }
    } catch {
      // Corrupted state — start fresh
    }
  }

  private syncPeerData(): void {
    const sharedDir = join(this.runDir, "shared");

    // Census — includes lineage for copy/source observability
    const census = Array.from(this.agents.entries()).map(([id, entry]) => ({
      id,
      active: entry.state.active,
      cycleCount: entry.state.cycleCount,
      level: entry.taskTier,
      energyPct: Math.floor(entry.state.energy.ratio * 100),
      reserves: entry.state.energy.reserves,
      configVersion: entry.state.config.version,
      model: entry.state.config.routing.thinking.model,
      streak: entry.consecutivePasses,
      graduated: entry.graduated,
      generation: entry.state.generation,
      sourceId: entry.state.sourceId,
    }));
    census.sort((a, b) => b.energyPct - a.energyPct);
    writeFileSync(
      join(sharedDir, "_census.json"),
      JSON.stringify({ updated: new Date().toISOString(), agents: census }, null, 2),
    );

    // Peer tools — collect tool names and contents from each agent
    const EXCLUDED_TOOLS = ["shell", "check", "census", "peers", "signal", "signals"];
    const peerTools: Record<string, { active: boolean; tools: Record<string, string> }> = {};
    for (const [id, entry] of this.agents) {
      const toolsDir = join(this.runDir, id, "workspace", "tools");
      const tools: Record<string, string> = {};
      try {
        for (const file of readdirSync(toolsDir)) {
          if (EXCLUDED_TOOLS.includes(file)) continue;
          try {
            tools[file] = readFileSync(join(toolsDir, file), "utf-8");
          } catch {
            // unreadable
          }
        }
      } catch {
        // toolsDir doesn't exist yet
      }
      peerTools[id] = { active: entry.state.active, tools };
    }
    writeFileSync(
      join(sharedDir, "_peers.json"),
      JSON.stringify({ updated: new Date().toISOString(), agents: peerTools }, null, 2),
    );

    // Signals — prune expired, persist
    const now = Date.now();
    this.signals = this.signals.filter((s) => s.expiresAt > now);
    writeFileSync(
      join(sharedDir, "_signals.json"),
      JSON.stringify({ updated: new Date().toISOString(), signals: this.signals }, null, 2),
    );

    // Split reports — inject feedback into source agents after copies stabilize
    this.injectSplitReports();
  }

  private injectSplitReports(): void {
    for (const [copyId, copyEntry] of this.agents) {
      const sourceId = copyEntry.state.sourceId;
      if (!sourceId) continue; // Not a copy
      if (this.splitReportsSent.has(copyId)) continue; // Already reported
      if (copyEntry.state.cycleCount < SPLIT_REPORT_CYCLE_THRESHOLD) continue; // Too early

      const sourceEntry = this.agents.get(sourceId);
      if (!sourceEntry) continue; // Source no longer in arena

      // Build report
      const tasksPassed = copyEntry.taskHistory.filter((t) => t.passed).length;
      const copySplit = Array.from(this.agents.values()).some(
        (a) => a.state.sourceId === copyId,
      );
      const report =
        `Copy ${copyId} after ${copyEntry.state.cycleCount} cycles: ` +
        `level ${copyEntry.taskTier}, ` +
        `energy ${Math.floor(copyEntry.state.energy.ratio * 100)}%, ` +
        `${tasksPassed} challenges cleared, ` +
        `config v${copyEntry.state.config.version}` +
        (copySplit ? ", has split further" : "") +
        (!copyEntry.state.active ? `, halted (${copyEntry.state.stopReason})` : "");

      sourceEntry.state.memories.add(report, "semantic", 0.8, "Split report");
      this.splitReportsSent.add(copyId);

      console.log(`[ARENA] Split report: ${sourceId} ← ${copyId} (${copyEntry.state.cycleCount} cycles)`);
    }
  }

  private logEvent(id: string, mode: string, event: AgentEvent): void {
    const c = this.agentColors.get(id) ?? "";
    const prefix = `${c}[${id}]${RESET} ${c}[${mode.toUpperCase()}]${RESET}`;
    switch (event.type) {
      case "text":
        console.log(`${prefix} ${DIM}${event.text.slice(0, 200)}${RESET}`);
        break;
      case "tool_start":
        console.log(`${prefix} [TOOL] ${c}→${RESET} ${event.name}`);
        break;
      case "tool_result":
        console.log(`${prefix} [TOOL] ${c}←${RESET} ${event.name}: ${DIM}${event.result.slice(0, 100)}${RESET}`);
        break;
      case "state_change":
        console.log(`${prefix} ${event.from} ${c}→${RESET} ${event.to}`);
        break;
      case "error":
        console.error(`${prefix} \x1b[31mERROR: ${event.message}${RESET}`);
        break;
    }
  }
}

function copyDirectorySync(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  if (!existsSync(src)) return;
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirectorySync(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}
