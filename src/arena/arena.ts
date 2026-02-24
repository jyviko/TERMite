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

export class Arena {
  private agents = new Map<string, AgentEntry>();
  private agentColors = new Map<string, string>();
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

    // Peer visibility timer: every 15s, write leaderboard + peer tools
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

    // Drop initial task
    const task = this.taskGenerator.generateTask(1, 0);
    this.taskGenerator.writeTaskToWorkspace(task, workspacePath);
    machine.setVerifyScript(this.taskGenerator.getVerifyScript(task));

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
      taskTier: 1,
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
    try {
      for await (const event of entry.stateMachine.run()) {
        this.logEvent(id, entry.state.mode, event);

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

    // Tier escalation: 3 consecutive passes → tier up (or graduate at tier 5)
    if (entry.consecutivePasses >= 3) {
      if (entry.taskTier >= 5) {
        entry.graduated = true;
        entry.consecutivePasses = 0;
        await this.onGraduation(id, entry);
        return; // No more structured tasks
      }
      entry.taskTier = Math.min(5, entry.taskTier + 1);
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

    // Check fork conditions
    if (
      entry.taskTier >= 5 &&
      entry.state.energy.ratio > 0.7 &&
      entry.state.cycleCount > 20
    ) {
      await this.fork(id, entry);
    }
  }

  private async onGraduation(id: string, entry: AgentEntry): Promise<void> {
    const workspacePath = join(this.runDir, id, "workspace");
    console.log(`[ARENA] ${id} GRADUATED from tier 5 — transitioning to open data`);

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
      const baseReward = TIER_REWARDS[5] ?? 300_000;
      const reward = Math.floor(rating.score * baseReward);

      if (reward > 0) {
        entry.stateMachine.setTaskReward(reward, 5);
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

  private async fork(sourceId: string, source: AgentEntry): Promise<void> {
    const INVESTMENT_RATIO = 0.3;
    const MIN_VIABLE_FORK = 20_000;

    const investment = Math.floor(source.state.energy.reserves * INVESTMENT_RATIO);
    if (investment < MIN_VIABLE_FORK) {
      console.log(
        `[ARENA] ${sourceId} cannot fork: investment ${investment} < minimum ${MIN_VIABLE_FORK}`,
      );
      return;
    }

    // Deduct investment from source
    source.state.energy.burnFlat(investment);

    try {
      const iteratedConfig = await this.iterator.iterate({
        sourceConfig: source.state.config,
        memories: source.state.memories.memories,
        taskHistory: source.taskHistory,
        generation: source.state.generation,
      });

      // Offspring inherit procedural + semantic memories (transferable knowledge)
      const inheritedMemories = new MemoryStore(
        source.state.memories.memories.filter((m) => m.type !== "episodic"),
      );

      const forkId = await this.spawnAgent(sourceId, iteratedConfig, investment, inheritedMemories);
      console.log(
        `[ARENA] ${sourceId} forked → ${forkId} (gen ${source.state.generation + 1}, invested ${investment} TEQ)`,
      );

      // Run the forked agent concurrently
      const forkEntry = this.agents.get(forkId);
      if (forkEntry) {
        this.runAgent(forkId, forkEntry).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[ARENA] Fork ${forkId} run failed: ${msg}`);
        });
      }
    } catch (err: unknown) {
      // Refund source on failure
      source.state.energy.credit(investment);
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[ARENA] Fork failed for ${sourceId}: ${msg}`);
    }
  }

  private syncPeerData(): void {
    const sharedDir = join(this.runDir, "shared");

    // Leaderboard
    const leaderboard = Array.from(this.agents.entries()).map(([id, entry]) => ({
      id,
      active: entry.state.active,
      cycleCount: entry.state.cycleCount,
      taskTier: entry.taskTier,
      energyPct: Math.floor(entry.state.energy.ratio * 100),
      reserves: entry.state.energy.reserves,
      configVersion: entry.state.config.version,
      model: entry.state.config.routing.thinking.model,
      consecutivePasses: entry.consecutivePasses,
      graduated: entry.graduated,
    }));
    leaderboard.sort((a, b) => b.energyPct - a.energyPct);
    writeFileSync(
      join(sharedDir, "_leaderboard.json"),
      JSON.stringify({ updated: new Date().toISOString(), agents: leaderboard }, null, 2),
    );

    // Peer tools — collect tool names and contents from each agent
    const peerTools: Record<string, { active: boolean; tools: Record<string, string> }> = {};
    for (const [id, entry] of this.agents) {
      const toolsDir = join(this.runDir, id, "workspace", "tools");
      const tools: Record<string, string> = {};
      try {
        for (const file of readdirSync(toolsDir)) {
          if (["shell", "check", "leaderboard", "peers"].includes(file)) continue;
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
