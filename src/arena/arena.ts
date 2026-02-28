import { mkdirSync, existsSync, readFileSync, writeFileSync, copyFileSync, readdirSync, symlinkSync, unlinkSync, lstatSync } from "node:fs";
import { createInterface } from "node:readline";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { AgentEvent, ChallengeResult, ArenaEntryData } from "../types/index.js";
import { LLM } from "../llm/index.js";
import { Executor } from "../executor/index.js";
import { AgentStateManager } from "../state/agent-state.js";
import { MemoryStore } from "../state/memory.js";
import { AgentStateMachine } from "../loop/state-machine.js";
import { lookupBountyMultiplier } from "../loop/resolve.js";
import { ConfigIterator } from "./iteration.js";
import { SharedBudget } from "./shared-budget.js";
import { TEQPool } from "./teq-pool.js";
import { SnapshotManager } from "./snapshots.js";
import { ChallengePool } from "./challenge-pool.js";
import { ChallengeGenerator } from "./challenge-generator.js";
import { SeededRng } from "../util/rng.js";

interface AgentEntry {
  stateMachine: AgentStateMachine;
  state: AgentStateManager;
  executor: Executor;
  challengeHistory: ChallengeResult[];
  active: boolean;
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
  snapshotIntervalMs?: number;
  noSnapshots?: boolean;
  maxCycles?: number;
  breakCycles?: number;
  /** Fixed seed for environment randomness (challenges, pool trickle, config mutations). */
  seed?: number;
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
  private challengePool: ChallengePool;
  private challengeGenerator: ChallengeGenerator;
  private iterator: ConfigIterator;
  private rng: SeededRng | undefined;
  private config: ArenaConfig;
  private runDir = "";
  private snapshots: SnapshotManager | null = null;

  // Cycle breakpoint state
  private _pauseGate: Promise<void> | null = null;
  private _pauseResolve: (() => void) | null = null;
  private _nextBreakAt: number | null = null;
  private _breakTriggered = false; // debounce: only one prompt at a time

  /** Base pool size for Haiku (1.0×). Scales up proportionally for costlier models. */
  private static readonly BASE_POOL = 5_000_000;

  /** Pool size scaled to the configured model's token cost. */
  private scaledPoolSize(): number {
    const multiplier = lookupBountyMultiplier(this.config.model ?? "claude-haiku-4-5-20251001");
    return Math.floor(Arena.BASE_POOL * multiplier);
  }

  constructor(config: ArenaConfig) {
    this.config = config;
    this.llm = new LLM({ apiKey: config.apiKey, baseUrl: config.baseUrl });
    this.sharedBudget = new SharedBudget(config.totalBudget);
    const scaledPool = this.scaledPoolSize();
    this.teqPool = TEQPool.initialize({
      initialBalance: config.poolInitialBalance ?? scaledPool,
      regenPerCycle: config.poolRegenPerCycle,
      maxBalance: config.poolMaxBalance ?? scaledPool,
    });
    this.rng = config.seed != null ? new SeededRng(config.seed) : undefined;
    this.challengeGenerator = new ChallengeGenerator(this.rng);
    this.challengePool = new ChallengePool("", this.challengeGenerator, this.rng?.fork()); // sharedDir set in start()/resume()
    this.iterator = new ConfigIterator(this.llm, this.rng?.fork());
  }

  /** Scale pool regen rate sublinearly with population to create carrying capacity. */
  private calibratePool(): void {
    const BASE_REGEN_PER_AGENT = 50_000;
    const entries = Array.from(this.agents.values()).filter(e => e.active);
    if (entries.length === 0) return;

    const totalMultiplier = entries.reduce((sum, e) => {
      return sum + lookupBountyMultiplier(e.state.config.routing.thinking.model);
    }, 0);
    const avgMultiplier = totalMultiplier / entries.length;

    // sqrt(n) makes each additional agent contribute less regen than the last.
    // 8 Sonnet agents: sqrt(8) × 50K × 3.0 ≈ 424K/tick — viable but scarce.
    // 80 agents: sqrt(80) × 50K × 3.0 ≈ 1.34M/tick — heavy competition.
    const scaledRegen = Math.floor(BASE_REGEN_PER_AGENT * Math.sqrt(entries.length) * avgMultiplier);
    this.teqPool.setRegenRate(scaledRegen);
  }

  async start(): Promise<void> {
    // Each run gets its own timestamped directory under workspaceRoot
    const runId = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    this.runDir = join(this.config.workspaceRoot, `run-${runId}`);
    mkdirSync(this.runDir, { recursive: true });
    mkdirSync(join(this.runDir, "shared"), { recursive: true });
    mkdirSync(join(this.runDir, "shared", "challenges"), { recursive: true });

    // Initialize challenge pool with shared directory
    const sharedDir = resolve(join(this.runDir, "shared"));
    this.challengePool = new ChallengePool(sharedDir, this.challengeGenerator, this.rng?.fork());

    // Keep a stable "latest" symlink pointing to this run
    const latestLink = join(this.config.workspaceRoot, "latest");
    try { unlinkSync(latestLink); } catch { /* didn't exist or wasn't a symlink */ }
    symlinkSync(this.runDir, latestLink);

    console.log(`Run directory: ${this.runDir}`);

    // Initialize snapshots
    if (!this.config.noSnapshots) {
      this.snapshots = new SnapshotManager({
        runDir: this.runDir,
        intervalMs: this.config.snapshotIntervalMs,
      });
      await this.snapshots.init();
    }

    // Initialize pool ledger
    this.teqPool.setLedger(join(this.runDir, "shared", "_pool_ledger.jsonl"));

    // Seed agents from previous runs — config + distilled memories carry over, fresh energy
    let seeded = 0;
    for (const seedPath of this.config.seedPaths ?? []) {
      if (seeded >= this.config.agentCount) break;
      try {
        const ancestor = await AgentStateManager.load(seedPath);

        // Carry over procedural, semantic, and high-value episodic memories.
        // Low-importance episodic is context-specific noise, but high-importance
        // episodes carry operational knowledge not yet crystallized.
        const EPISODIC_INHERIT_THRESHOLD = 0.8;
        const distilled = new MemoryStore(
          ancestor.memories.memories.filter(
            (m) => m.type !== "episodic" || m.importance >= EPISODIC_INHERIT_THRESHOLD,
          ),
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

    // Initial challenge pool population
    this.challengePool.refresh(0, this.agents.size);

    this.calibratePool();
  }

  /** Resume a previously stopped run. Loads agent state + arena metadata, spins fresh containers on existing workspaces. */
  async resume(runDir: string): Promise<void> {
    this.runDir = runDir;

    // Restore arena-level state
    this.restoreArenaState();

    // Restore pool state
    const poolPath = join(this.runDir, "shared", "_pool.json");
    TEQPool.reset();
    const scaledPool = this.scaledPoolSize();
    this.teqPool = await TEQPool.loadOrCreate(poolPath, {
      initialBalance: this.config.poolInitialBalance ?? scaledPool,
      regenPerCycle: this.config.poolRegenPerCycle,
      maxBalance: this.config.poolMaxBalance ?? scaledPool,
    });

    // Restore challenge pool
    const sharedDir = resolve(join(this.runDir, "shared"));
    const challengeStatePath = join(sharedDir, "challenges", "_state.json");
    this.challengePool = ChallengePool.restore(challengeStatePath, sharedDir, this.challengeGenerator, this.rng?.fork());

    // Kill any orphaned containers from this run
    const agentDirs = readdirSync(this.runDir).filter((d) => d.startsWith("agent-"));
    for (const dir of agentDirs) {
      const executor = new Executor({
        workingDir: join(this.runDir, dir, "workspace"),
        containerName: `termite-${dir}`,
      });
      await executor.stop().catch(() => {});
    }

    interface ResumeCandidate {
      dir: string;
      state: AgentStateManager;
      entryData: ArenaEntryData;
    }

    const candidates: ResumeCandidate[] = [];
    let skipped = 0;

    for (const dir of agentDirs) {
      const statePath = join(this.runDir, dir, "state.json");
      const entryPath = join(this.runDir, dir, "entry.json");

      if (!existsSync(statePath) || !existsSync(entryPath)) continue;

      let entryData: ArenaEntryData;
      try {
        entryData = JSON.parse(readFileSync(entryPath, "utf-8"));
      } catch {
        continue; // Corrupted entry.json — skip agent
      }

      const state = await AgentStateManager.load(statePath);

      // Load cycle history from metrics.jsonl (SSoT for per-cycle records)
      const metricsPath = join(this.runDir, dir, "metrics.jsonl");
      state.energy.cycleHistory = AgentStateMachine.loadMetrics(metricsPath);

      // Skip dead agents
      if (state.energy.remaining <= 0) {
        skipped++;
        continue;
      }

      // Reactivate (shutdown may have left mode as stopped)
      state.active = true;
      state.stopReason = null;
      state.mode = "active";

      candidates.push({ dir, state, entryData });
    }

    // Sort by energy descending — highest-value agents start first
    candidates.sort((a, b) => b.state.energy.reserves - a.state.energy.reserves);

    const CONTAINER_STAGGER_MS = 500;
    let resumed = 0;

    for (const { dir, state, entryData } of candidates) {
      const workspacePath = join(this.runDir, dir, "workspace");
      const executor = new Executor({
        workingDir: workspacePath,
        containerName: `termite-${dir}`,
        extraVolumes: [`${sharedDir}:/shared:ro`],
      });
      await executor.start();

      // Stagger container startups to avoid Docker resource exhaustion
      if (resumed > 0) {
        await new Promise((r) => setTimeout(r, CONTAINER_STAGGER_MS));
      }

      const savePath = join(this.runDir, dir, "state.json");
      const machine = new AgentStateMachine(this.llm, executor, state, this.teqPool, savePath);

      // Wire challenge handler
      this.wireChallengeHandler(dir, machine);

      // Wire fork handler
      machine.setForkHandler(() => this.handleForkRequest(dir));

      // Wire signal handler
      machine.setSignalHandler((msg) => this.handleSignal(dir, state.cycleCount, msg));

      const entry: AgentEntry = {
        stateMachine: machine,
        state,
        executor,
        challengeHistory: entryData.challengeHistory ?? [],
        active: true,
      };

      this.agents.set(dir, entry);
      this.agentColors.set(dir, AGENT_COLORS[(this.agents.size - 1) % AGENT_COLORS.length]!);
      resumed++;

      if (resumed % 10 === 0) {
        console.log(`[ARENA] Started ${resumed}/${candidates.length} containers...`);
      }
    }

    console.log(`[ARENA] Resumed ${resumed} agents, skipped ${skipped} dead agents from ${runDir}`);

    // Initialize snapshots (may already have .jj/.git from prior run)
    if (!this.config.noSnapshots) {
      this.snapshots = new SnapshotManager({
        runDir: this.runDir,
        intervalMs: this.config.snapshotIntervalMs,
      });
      await this.snapshots.init();
    }

    // Initialize pool ledger (appends to existing file)
    this.teqPool.setLedger(join(this.runDir, "shared", "_pool_ledger.jsonl"));

    this.calibratePool();
  }

  private pauseAgents(): void {
    if (this._pauseGate) return; // already paused
    this._pauseGate = new Promise<void>((resolve) => {
      this._pauseResolve = resolve;
    });
  }

  private resumeAgents(): void {
    this._pauseResolve?.();
    this._pauseGate = null;
    this._pauseResolve = null;
  }

  private totalCycles(): number {
    let sum = 0;
    for (const entry of this.agents.values()) sum += entry.state.cycleCount;
    return sum;
  }

  private async promptContinue(cycleCount: number): Promise<boolean> {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return new Promise<boolean>((resolve) => {
      rl.question(
        `\n\x1b[33m[ARENA BREAKPOINT]\x1b[0m ${cycleCount} cumulative cycles reached. Continue? [Y/n] `,
        (answer) => {
          rl.close();
          resolve(answer.trim().toLowerCase() !== "n");
        },
      );
    });
  }

  async run(): Promise<void> {
    const poolPath = join(this.runDir, "shared", "_pool.json");

    // Initialize cycle breakpoint
    if (this.config.maxCycles != null) {
      this._nextBreakAt = this.config.maxCycles;
    }

    // Regeneration timer: every 10s, add TEQs, refresh challenges, persist state
    // Only regenerate when at least one agent has completed a cycle (is actively running)
    const challengeStatePath = join(this.runDir, "shared", "challenges", "_state.json");
    const regenTimer = setInterval(async () => {
      const activeEntries = Array.from(this.agents.values()).filter(
        (e) => e.state.active && e.state.cycleCount > 0,
      );
      if (activeEntries.length > 0) {
        this.teqPool.regenerate(activeEntries.length);

        // Compute global cycle as max across active agents
        const globalCycle = Math.max(...activeEntries.map(e => e.state.cycleCount));
        this.challengePool.refresh(globalCycle, activeEntries.length);
        this.challengePool.persist(challengeStatePath);
      }
      await this.teqPool.persist(poolPath).catch(() => {});

      // Cycle breakpoint check
      if (this._nextBreakAt != null && !this._breakTriggered) {
        const total = this.totalCycles();
        if (total >= this._nextBreakAt) {
          this._breakTriggered = true;
          this.pauseAgents();
          const cont = await this.promptContinue(total);
          if (!cont) {
            this.resumeAgents();
            await this.shutdown();
            process.exit(0);
          }
          const interval = this.config.breakCycles ?? this.config.maxCycles ?? 50;
          this._nextBreakAt = total + interval;
          this._breakTriggered = false;
          this.resumeAgents();
        }
      }
    }, 10_000);

    // Peer visibility timer: every 15s, write census + peer tools
    const peerTimer = setInterval(() => {
      this.syncPeerData();
    }, 15_000);
    this.syncPeerData(); // initial write

    // Start periodic snapshots
    this.snapshots?.start();

    try {
      const promises = Array.from(this.agents.entries()).map(([id, entry]) =>
        this.runAgent(id, entry),
      );
      await Promise.allSettled(promises);
    } finally {
      clearInterval(regenTimer);
      clearInterval(peerTimer);
      await this.teqPool.persist(poolPath).catch(() => {});
      await this.snapshots?.stop("run-complete").catch(() => {});
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
        writeFileSync(
          join(this.runDir, id, "entry.json"),
          JSON.stringify(this.buildEntryData(entry), null, 2),
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[ARENA] Failed to save ${id}: ${msg}`);
      }
    });
    await Promise.allSettled(saves);

    // Final snapshot before stopping containers
    if (this.snapshots) {
      await this.snapshots.snapshotSync("shutdown").catch(() => {});
    }

    // Close ledger
    this.teqPool.closeLedger();

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

    // Seed workspace (tools + check stub)
    this.seedWorkspace(workspacePath);

    // Wire challenge handler — agent runs check, arena routes to challenge pool
    this.wireChallengeHandler(id, machine);

    // Wire fork handler — agent calls fork tool, arena executes
    machine.setForkHandler(() => this.handleForkRequest(id));

    // Wire signal handler — agent calls signal tool, arena mediates shared write
    machine.setSignalHandler((msg) => this.handleSignal(id, state.cycleCount, msg));

    // If fork, copy source agent's tools (overrides seeded defaults)
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
      challengeHistory: [],
      active: true,
    };

    this.agents.set(id, entry);
    this.agentColors.set(id, AGENT_COLORS[(this.agents.size - 1) % AGENT_COLORS.length]!);
    return id;
  }

  private async runAgent(id: string, entry: AgentEntry): Promise<void> {
    try {
      for await (const event of entry.stateMachine.run()) {
        // Honour pause gate (cycle breakpoints)
        if (this._pauseGate) await this._pauseGate;

        this.logEvent(id, entry.state.mode, event);

        // Check shared budget
        if (this.sharedBudget.exhausted) {
          entry.state.terminate("arena_budget_exhausted");
          break;
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
        this.teqPool.deposit(returnAmount, id);
      }

      // Preserve workspace + arena metadata (stopped agent)
      await entry.state.save(join(this.runDir, id, "state.json"));
      writeFileSync(join(this.runDir, id, "entry.json"), JSON.stringify(this.buildEntryData(entry), null, 2));
      await entry.executor.stop().catch(() => {});
      this.calibratePool();
    }
  }

  /** Seed a workspace with default tools and the check stub. */
  private seedWorkspace(workspacePath: string): void {
    const outputDir = join(workspacePath, "output");
    const workDir = join(workspacePath, "work");
    const toolsDir = join(workspacePath, "tools");

    mkdirSync(outputDir, { recursive: true });
    mkdirSync(workDir, { recursive: true });
    mkdirSync(toolsDir, { recursive: true });

    // Seed default tools from project tools/ directory
    const defaultToolsDir = join(dirname(fileURLToPath(import.meta.url)), "../../tools");
    if (!existsSync(join(toolsDir, "shell"))) {
      try {
        for (const name of readdirSync(defaultToolsDir)) {
          const src = readFileSync(join(defaultToolsDir, name));
          writeFileSync(join(toolsDir, name), src, { mode: 0o755 });
        }
      } catch {
        // tools/ dir may not exist in test environments
      }
    }

    // Write check stub — routes through challengeHandler in state-machine
    const checkStub = `#!/bin/bash
# description: check - Probe the environment. No args: scan available challenges. With challenge ID: verify your output.
echo "__VERIFY__"`;
    writeFileSync(join(toolsDir, "check"), checkStub, {
      mode: 0o755,
      encoding: "utf-8",
    });
  }

  /** Wire challenge handler for an agent's state machine. */
  private wireChallengeHandler(id: string, machine: AgentStateMachine): void {
    machine.setChallengeHandler(async (input: string) => {
      const trimmed = input.trim();
      if (!trimmed) {
        return this.challengePool.scan();
      }

      const entry = this.agents.get(id);
      if (!entry) return "FAIL: agent not found";

      const result = await this.challengePool.attempt(trimmed, id, entry.executor);

      if (result.passed && result.reward != null && result.difficulty != null) {
        entry.stateMachine.setTaskReward(result.reward, result.difficulty);
        entry.challengeHistory.push({
          challengeId: trimmed,
          difficulty: result.difficulty,
          passed: true,
          reward: result.reward,
          cyclesSinceAppeared: 0,
        });
      }

      return result.message;
    });
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
    const poolBonus = await this.teqPool.withdraw(requestedBonus, id);

    // Inherit procedural + semantic memories, plus high-value episodic.
    // Low-importance episodic is context-specific noise, but high-importance
    // episodes (successes, critical discoveries) carry operational knowledge
    // that the agent may not have crystallized into procedural rules yet.
    const EPISODIC_INHERIT_THRESHOLD = 0.8;
    const inheritedMemories = new MemoryStore(
      entry.state.memories.memories.filter(
        (m) => m.type !== "episodic" || m.importance >= EPISODIC_INHERIT_THRESHOLD,
      ),
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

    try {
      // One config iteration for copy — variation via LLM temperature
      const copyConfig = await this.iterator.iterate({
        sourceConfig: entry.state.config,
        memories: entry.state.memories.memories,
        challengeHistory: entry.challengeHistory,
        generation: entry.state.generation,
      });

      // Source invests half its reserves; copy gets investment + pool bonus
      const copyReserves = investment + poolBonus;
      entry.state.energy.burnFlat(investment);

      const copy = await this.spawnAgent(id, copyConfig, copyReserves, inheritedMemories);
      this.calibratePool();

      const gen = entry.state.generation + 1;
      console.log(
        `[ARENA] ${id} split → ${copy} (gen ${gen}, invested ${investment} + ${poolBonus} bonus = ${copyReserves} TEQ)`,
      );

      // Source records the split
      entry.state.memories.add(
        `Split at cycle ${entry.state.cycleCount}. Invested ${investment.toLocaleString()} TEQ. ` +
        `Copy ${copy} created with ${copyReserves.toLocaleString()} TEQ. ` +
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

      return `SPLIT: ${copy} created with ${copyReserves.toLocaleString()} TEQ. You invested ${investment.toLocaleString()} TEQ. Remaining: ${entry.state.energy.reserves.toLocaleString()} TEQ.`;
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
      challengesSolved: entry.challengeHistory.filter(c => c.passed).length,
      energyPct: Math.floor(entry.state.energy.ratio * 100),
      reserves: entry.state.energy.reserves,
      configVersion: entry.state.config.version,
      model: entry.state.config.routing.thinking.model,
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

    // Inject population context into each active agent's state machine
    const activeAgents = census.filter(a => a.active);
    const totalAgents = census.length;
    for (const [id, entry] of this.agents) {
      if (!entry.state.active) continue;

      const myRank = census.findIndex(a => a.id === id) + 1;
      const myPct = Math.floor(entry.state.energy.ratio * 100);
      const medianPct = census.length > 0
        ? census[Math.floor(census.length / 2)]!.energyPct
        : 0;

      // Generation distribution
      const genCounts = new Map<number, number>();
      for (const a of census) {
        genCounts.set(a.generation, (genCounts.get(a.generation) ?? 0) + 1);
      }
      const genParts = Array.from(genCounts.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([gen, count]) => `${count}×gen${gen}`)
        .join(", ");

      const popBlock = [
        "Population:",
        `- Agents: ${activeAgents.length} active / ${totalAgents} total`,
        `- Your rank: ${myRank}${ordinal(myRank)} by energy (${myPct}%), median: ${medianPct}%`,
        `- Generations: ${genParts}`,
      ].join("\n");

      entry.stateMachine.setPopulationContext(popBlock);
    }

    // Persist entry.json for active agents
    for (const [id, entry] of this.agents) {
      if (!entry.state.active) continue;
      try {
        writeFileSync(
          join(this.runDir, id, "entry.json"),
          JSON.stringify(this.buildEntryData(entry), null, 2),
        );
      } catch {
        // Non-critical — will retry next sync
      }
    }

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
      const challengesPassed = copyEntry.challengeHistory.filter((c) => c.passed).length;
      const copySplit = Array.from(this.agents.values()).some(
        (a) => a.state.sourceId === copyId,
      );
      const report =
        `Copy ${copyId} after ${copyEntry.state.cycleCount} cycles: ` +
        `energy ${Math.floor(copyEntry.state.energy.ratio * 100)}%, ` +
        `${challengesPassed} challenges cleared, ` +
        `config v${copyEntry.state.config.version}` +
        (copySplit ? ", has split further" : "") +
        (!copyEntry.state.active ? `, halted (${copyEntry.state.stopReason})` : "");

      sourceEntry.state.memories.add(report, "semantic", 0.8, "Split report");
      this.splitReportsSent.add(copyId);

      console.log(`[ARENA] Split report: ${sourceId} ← ${copyId} (${copyEntry.state.cycleCount} cycles)`);
    }
  }

  private buildEntryData(entry: AgentEntry): ArenaEntryData {
    return {
      challengeHistory: entry.challengeHistory,
    };
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

  /** List snapshots for a run directory. */
  static async listSnapshots(runDir: string): Promise<import("./snapshots.js").SnapshotRef[]> {
    const mgr = new SnapshotManager({ runDir });
    await mgr.init();
    return mgr.list();
  }

  /** Rewind a run directory to a previous snapshot. */
  static async rewindRun(runDir: string, ref: string): Promise<void> {
    const mgr = new SnapshotManager({ runDir });
    await mgr.init();
    await mgr.rewind(ref);
  }
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return s[(v - 20) % 10] ?? s[v] ?? s[0]!;
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
