import Anthropic from "@anthropic-ai/sdk";
import { appendFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import type { AgentEvent, CycleRecord, DriveName, Outcome } from "../types/index.js";
import { DRIVE_NAMES } from "../types/index.js";
import type { LLM } from "../llm/index.js";
import { ZERO_USAGE } from "../llm/index.js";
import type { Executor } from "../executor/index.js";
import type { DriveSystem } from "../state/drives.js";
import { AgentStateManager } from "../state/agent-state.js";
import { AgenticLoop, type ToolExecutor } from "./agentic-loop.js";
import { parseResolveResponse, RESOLVE_ERROR_DEFAULT, computeIncome, lookupBountyMultiplier } from "./resolve.js";
import { parseMemorizeResponse, applyMemorizeOperations, type MemorizeOps } from "./memorize.js";
import type { TEQPool } from "../arena/teq-pool.js";

const BASE_MEMORY_TOKEN_BUDGET = 4000;

// ── Per-cycle mutable state ─────────────────────────────────────────

interface CycleContext {
  sources: string[];
  outcome: Outcome | null;
  relevance: number;
  actions: string[];
  model: string;
  memoryOps: string[];
  idleSeconds: number;
}

function freshCycle(): CycleContext {
  return { sources: [], outcome: null, relevance: 0, actions: [], model: "", memoryOps: [], idleSeconds: 0 };
}

// ── State machine ───────────────────────────────────────────────────

export class AgentStateMachine {
  private llm: LLM;
  private loop: AgenticLoop;
  private savePath: string;

  // Task reward (set by arena, cleared after first resolve)
  private taskReward: number | null = null;
  private taskTier: number | null = null;

  // Challenge handler — provided by arena, routes check tool calls
  private challengeHandler: ((input: string) => Promise<string>) | null = null;

  // Fork handler — provided by arena, called when agent uses fork tool
  private forkHandler: ((directive: string) => Promise<string>) | null = null;

  // Signal handler — provided by arena, called when agent uses signal tool
  private signalHandler: ((message: string) => Promise<string>) | null = null;

  // Previous-cycle drive levels for direction arrows in state block
  private previousDriveLevels: Record<DriveName, number> | null = null;

  // Population context — provided by arena from census/pool data
  private populationContext: string = "";

  // Current cycle
  private cycleCtx = freshCycle();
  private availableToolCount = 0;

  // Challenge tracking for fingerprint
  private challengesSolved = 0;
  private lastChallengeDifficulty = 0;

  constructor(
    llm: LLM,
    private executor: Executor,
    private state: AgentStateManager,
    private teqPool: TEQPool,
    savePath?: string,
  ) {
    this.llm = llm;
    this.loop = new AgenticLoop(llm);
    this.savePath = savePath ?? `saves/${state.id}.json`;
  }

  // ── Lifecycle loop ──────────────────────────────────────────────────

  async *run(): AsyncGenerator<AgentEvent> {
    while (this.state.active) {
      this.state.energy.burnBaseCost();
      if (!this.state.checkVitalSigns()) break;

      this.cycleCtx = freshCycle();
      yield* this.cycle();
      yield* this.finalizeCycle();
      await this.state.save(this.savePath);

      // Agent-requested idle — conserve energy by waiting between cycles
      if (this.cycleCtx.idleSeconds > 0) {
        yield { type: "idle", seconds: this.cycleCtx.idleSeconds } as AgentEvent;
        await new Promise((r) => setTimeout(r, this.cycleCtx.idleSeconds * 1000));
      }
    }

    if (!this.state.active) {
      await this.state.save(this.savePath);
      yield { type: "state_change", from: this.state.mode, to: "stopped" };
    }
  }

  // ── Finalize: Resolve → Store Pair → Income → Memorize → Decay ───

  private async *finalizeCycle(): AsyncGenerator<AgentEvent> {
    const goal = this.state.goal ?? this.deriveGoal() ?? "Explore and persist";
    const actions = this.summarizeRecentActions();
    const stateBlock = this.buildStateBlock();

    // 1. Resolve — post-turn in the agentic loop conversation (cached prefix)
    yield { type: "phase_change", phase: "resolving" };
    const resolveMessage = this.state.config.resolvePrompt
      .replace("{actions}", actions)
      .replace("{cycleCost}", String(this.state.energy.currentCycleCost))
      .replace("{stateBlock}", stateBlock);

    let resolveResult = RESOLVE_ERROR_DEFAULT;
    try {
      const r = await this.loop.postTurn(resolveMessage, this.state.config.routing.resolveMaxTokens);
      resolveResult = { ...parseResolveResponse(r.text), usage: r.usage };
      this.state.energy.burn(this.cycleCtx.model, r.usage);
    } catch {
      // postTurn failed — use defaults, no energy to burn
    }

    // Update cycle context from resolve
    this.cycleCtx.outcome = resolveResult.outcome;
    this.cycleCtx.relevance = resolveResult.value;

    // 2. Store cycle as user/agent memory pair (SHORT TERM — accumulates)
    const context = `Cycle ${this.state.cycleCount}. Goal: ${goal}. Energy: ${this.state.energy.remaining}/${this.state.energy.capacity}`;
    const cycleContent = `${actions}\nOutcome: ${resolveResult.outcome}. Lesson: ${resolveResult.lesson}`;
    const importance = resolveResult.outcome === "success" ? 0.9
      : resolveResult.outcome === "partial" ? 0.7
      : 0.5;
    this.state.memories.add(cycleContent, "episodic", importance, context);

    // 3. Compute and credit income
    const income = await computeIncome(
      resolveResult.outcome,
      this.taskReward,
      this.teqPool,
      this.state.energy.currentCycleCost,
      this.taskTier ?? undefined,
      this.cycleCtx.model,
      this.state.id,
    );
    if (income.base > 0) this.state.energy.credit(income.base);
    if (income.bounty > 0) this.state.energy.creditFromPool(income.bounty);
    this.cycleCtx.sources.push(...income.sources);

    // Clear one-time task reward
    this.taskReward = null;
    this.taskTier = null;

    // 4. Memorize — post-turn in the agentic loop conversation (cached prefix)
    yield { type: "phase_change", phase: "memorizing" };
    const memorizeBudget = BASE_MEMORY_TOKEN_BUDGET + Math.floor(this.state.energy.earned / 200);
    const memorizeMessage = this.state.config.memorizePrompt
      .replace("{outcome}", resolveResult.outcome)
      .replace("{lesson}", resolveResult.lesson)
      .replace("{systemPrompt}", this.state.config.systemPrompt)
      .replace("{resolvePrompt}", this.state.config.resolvePrompt)
      .replace("{memoryCount}", String(this.state.memories.memories.length))
      .replace("{memories}", this.state.memories.formatMetadataOnly())
      .replace("{memoryTokens}", String(this.state.memories.totalTokenCost))
      .replace("{memoryBudget}", String(memorizeBudget))
      .replace("{stateBlock}", stateBlock)
      .replace("{populationBlock}", this.populationContext ?? "");

    let memorizeOps: MemorizeOps = {};
    try {
      const m = await this.loop.postTurn(memorizeMessage, this.state.config.routing.memorizeMaxTokens);
      memorizeOps = parseMemorizeResponse(m.text);
      this.state.energy.burn(this.cycleCtx.model, m.usage);
    } catch {
      // postTurn failed — no ops, no energy to burn
    }

    // 5. Apply memory operations (compress, forget, consolidate, promptRewrite)
    this.cycleCtx.idleSeconds = memorizeOps.idleSeconds ?? 0;
    const oldTokens = this.state.memories.totalTokenCost;
    this.cycleCtx.memoryOps = applyMemorizeOperations(memorizeOps, this.state.memories, this.state.config);
    const newTokens = this.state.memories.totalTokenCost;
    const tokensSaved = oldTokens - newTokens;
    if (tokensSaved > 0) {
      const bonus = Math.floor(tokensSaved * 2);
      this.state.energy.credit(bonus);
      this.cycleCtx.sources.push(`consolidation:${bonus}`);
    }

    // 6. End cycle — push CycleRecord to history (after memorize so its cost is included)
    this.state.energy.endCycle(
      this.state.cycleCount,
      this.cycleCtx.outcome,
      this.cycleCtx.sources.join(", "),
      this.cycleCtx.relevance,
      this.cycleCtx.model,
    );

    // 6b. Append to metrics.jsonl — SSoT for per-cycle history
    this.appendMetrics();

    // 7. Housekeeping — snapshot drive levels before update for next cycle's direction arrows
    this.previousDriveLevels = Object.fromEntries(
      DRIVE_NAMES.map((n) => [n, this.state.drives.drives[n].level]),
    ) as Record<DriveName, number>;

    // Base floor scales with model cost: 250 for Haiku (1×), 750 for Sonnet (3×), 1250 for Opus (5×).
    // Prevents cheap models from idling indefinitely at near-zero overhead.
    const BASE_FLOOR = 250;
    const modelFloor = Math.floor(BASE_FLOOR * lookupBountyMultiplier(this.state.config.routing.thinking.model));
    this.state.energy.computeBaseCost(this.state.memories.totalTokenCost, this.availableToolCount, modelFloor);
    this.state.drives.update(
      this.state.energy,
      this.state.memories.memories,
      this.state.cycleCount,
      this.state.generation,
    );
    this.state.cycleCount++;
  }

  // ── Single cycle: Think + Execute ─────────────────────────────────

  private async *cycle(): AsyncGenerator<AgentEvent> {
    const route = this.state.config.routing.thinking;
    this.cycleCtx.model = route.model;

    const tools = await this.buildTools();
    const toolNames = tools.map((t) => t.name);
    this.availableToolCount = tools.length;
    yield { type: "tools_available", tools: toolNames } as AgentEvent;

    const executor: ToolExecutor = async (name, input) => {
      return this.executeTool(name, input);
    };

    // Build messages: memory pairs (conversation history) + current awareness
    // Agents that earn more get bigger memory budgets — compound interest
    const memoryBudget = BASE_MEMORY_TOKEN_BUDGET + Math.floor(this.state.energy.earned / 200);
    const memoryMessages: Anthropic.MessageParam[] = this.state.memories.formatAsMessages(memoryBudget);

    // Mark last memory message for caching so system+memories prefix is a cache hit
    // on subsequent agentic loop iterations (tool use rounds)
    if (memoryMessages.length > 0) {
      const lastMem = memoryMessages[memoryMessages.length - 1]!;
      if (typeof lastMem.content === "string") {
        memoryMessages[memoryMessages.length - 1] = {
          ...lastMem,
          content: [{ type: "text" as const, text: lastMem.content, cache_control: { type: "ephemeral" as const } }],
        };
      }
    }

    for await (const event of this.loop.run({
      systemPrompt: this.state.config.systemPrompt,
      messages: [...memoryMessages, this.buildAwarenessMessage(toolNames)],
      tools,
      model: route.model,
      maxTokens: route.maxTokens,
      maxIterations: 25,
      executor,
      shouldStop: () =>
        route.maxCycleCost != null && this.state.energy.currentCycleVariableCost >= route.maxCycleCost,
      statusNote: () =>
        `Energy: ${this.state.energy.remaining}/${this.state.energy.capacity} TEQ, cycle cost: ${this.state.energy.currentCycleCost} TEQ (variable: ${this.state.energy.currentCycleVariableCost})`,
    })) {
      yield event;
      const extra = this.trackEvent(event);
      if (extra) yield extra;
      if (event.type === "error") break;
    }
  }

  private trackEvent(event: AgentEvent): AgentEvent | null {
    switch (event.type) {
      case "tool_start": {
        this.cycleCtx.actions.push(`→ ${event.name}`);
        return { type: "phase_change", phase: "executing" as const };
      }
      case "tool_use": {
        // Enrich the preceding tool_start entry with the actual input
        const raw = event.input?.input;
        const inputStr = typeof raw === "string" ? raw.slice(0, 200) : "";
        if (inputStr) {
          const lastIdx = this.cycleCtx.actions.length - 1;
          if (lastIdx >= 0 && this.cycleCtx.actions[lastIdx]!.startsWith("→")) {
            this.cycleCtx.actions[lastIdx] = `→ ${event.name}(${inputStr})`;
          }
        }
        return null;
      }
      case "tool_result":
        this.cycleCtx.actions.push(`← ${event.name}: ${event.result.slice(0, 300)}`);

        return null;
      case "text":
        this.cycleCtx.actions.push(event.text.slice(0, 300));
        return null;
      case "usage":
        this.state.energy.burn(this.cycleCtx.model, event);
        return null;
      default:
        return null;
    }
  }

  // ── Tool execution ────────────────────────────────────────────────

  private async executeTool(name: string, input: Record<string, unknown>): Promise<string> {
    const toolInput = String(input.input ?? "");

    // check is an internal tool — challenge handler routes scan/verify, never on agent's filesystem
    if (name === "check" && this.challengeHandler) {
      return this.challengeHandler(toolInput);
    }

    // fork is an internal tool — arena handles the actual split
    if (name === "fork" && this.forkHandler) {
      return this.forkHandler(toolInput);
    }

    const result = await this.executor.executeTool(`/workspace/tools/${name}`, toolInput);

    // Intercept __SIGNAL__ prefix in tool output — agent-created tools can
    // broadcast to the shared signal board by outputting this magic prefix.
    // Agents must discover this mechanism on their own (e.g., by examining fork).
    if (result.startsWith("__SIGNAL__") && this.signalHandler) {
      const message = result.slice("__SIGNAL__".length).trim();
      return this.signalHandler(message);
    }

    return result;
  }

  // ── Awareness message ─────────────────────────────────────────────

  private buildAwarenessMessage(toolNames: string[]): Anthropic.MessageParam {
    const drives = formatDrives(this.state.drives);
    const goal = this.deriveGoal();

    const parts = [
      `Energy: ${this.state.energy.remaining}/${this.state.energy.capacity}`,
      `Drives: ${drives}`,
      goal ? `Active goal: ${goal}` : null,
      toolNames.length > 0 ? `Tools: ${toolNames.join(", ")}` : null,
      `Cycle: ${this.state.cycleCount}`,
    ].filter(Boolean);

    return { role: "user" as const, content: parts.join("\n\n") };
  }

  private deriveGoal(): string | null {
    const active = this.state.drives.activeDrives();
    if (active.length === 0) return null;
    return active
      .sort((a, b) => b.level - a.level)
      .map((d) => this.state.drives.driveToGoal(d))
      .join(" ");
  }

  private async buildTools(): Promise<Anthropic.Tool[]> {
    const tools: Anthropic.Tool[] = [];

    try {
      const raw = await this.executor.executeShell(
        `for f in $(find /workspace/tools -maxdepth 1 -type f -executable 2>/dev/null); do ` +
        `name=$(basename "$f"); ` +
        `desc=$(sed -n '2s/^[#/]\\{1,2\\} *description: *//p' "$f" 2>/dev/null); ` +
        `echo "$name|$desc"; ` +
        `done`,
      );
      for (const line of raw.trim().split("\n")) {
        if (!line) continue;
        const sep = line.indexOf("|");
        const name = sep >= 0 ? line.slice(0, sep) : line;
        // Skip tool names that don't match the API's required pattern
        if (!/^[a-zA-Z0-9_-]{1,128}$/.test(name)) continue;
        const rawDesc = sep >= 0 ? line.slice(sep + 1).trim() : "";
        const dashIdx = rawDesc.indexOf(" - ");
        const desc = dashIdx >= 0 ? rawDesc.slice(dashIdx + 3) : rawDesc;
        tools.push({
          name,
          description: desc || name,
          input_schema: {
            type: "object" as const,
            properties: { input: { type: "string" } },
          },
        });
      }
    } catch {
      // Container not ready or no tools yet
    }

    return tools;
  }

  private summarizeRecentActions(): string {
    if (this.cycleCtx.actions.length === 0) return "(no actions taken)";
    return this.cycleCtx.actions.slice(-30).join("\n");
  }

  /** Derive the metrics.jsonl path from the save path (sibling file). */
  private get metricsPath(): string {
    return join(dirname(this.savePath), "metrics.jsonl");
  }

  /** Append the latest CycleRecord to the per-agent metrics.jsonl (SSoT for cycle history). */
  private appendMetrics(): void {
    const history = this.state.energy.cycleHistory;
    if (history.length === 0) return;
    const record = history[history.length - 1]!;

    // Count memories by type for strategy fingerprint
    const mems = this.state.memories.memories;
    const memCounts = { episodic: 0, semantic: 0, procedural: 0 };
    for (const m of mems) memCounts[m.type as keyof typeof memCounts]++;

    const line = {
      ...record,
      agentId: this.state.id,
      reserves: this.state.energy.remaining,
      fingerprint: {
        memEpisodic: memCounts.episodic,
        memSemantic: memCounts.semantic,
        memProcedural: memCounts.procedural,
        memTotalTokens: this.state.memories.totalTokenCost,
        promptVersion: this.state.config.version,
        toolCount: this.availableToolCount,
        challengesSolved: this.challengesSolved,
        preferredDifficulty: this.lastChallengeDifficulty,
        baseCost: this.state.energy.baseCost,
        cacheWriteCost: record.cacheWriteCost ?? 0,
        drives: {
          explore: this.state.drives.drives.explore.level,
          acquire: this.state.drives.drives.acquire.level,
          grow: this.state.drives.drives.grow.level,
          coordinate: this.state.drives.drives.coordinate.level,
        },
        generation: this.state.generation,
      },
      memoryOps: this.cycleCtx.memoryOps,
    };
    try {
      appendFileSync(this.metricsPath, JSON.stringify(line) + "\n");
    } catch {
      // Non-critical — metrics is observability, not correctness
    }
  }

  /** Load cycle history from a metrics.jsonl file. Returns parsed CycleRecords. */
  static loadMetrics(metricsPath: string): CycleRecord[] {
    try {
      const raw = readFileSync(metricsPath, "utf-8");
      return raw
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as CycleRecord);
    } catch {
      return [];
    }
  }

  setTaskReward(reward: number, difficulty: number): void {
    this.taskReward = reward;
    this.taskTier = difficulty;
    this.challengesSolved++;
    this.lastChallengeDifficulty = difficulty;
  }

  /** Set the challenge handler (provided by arena, routes check tool calls). */
  setChallengeHandler(handler: (input: string) => Promise<string>): void {
    this.challengeHandler = handler;
  }

  /** Set the fork handler (provided by arena, executed when agent calls fork tool). */
  setForkHandler(handler: (directive: string) => Promise<string>): void {
    this.forkHandler = handler;
  }

  /** Set the signal handler (provided by arena, executed when agent calls signal tool). */
  setSignalHandler(handler: (message: string) => Promise<string>): void {
    this.signalHandler = handler;
  }

  /** Set population context string (provided by arena from census/pool data). */
  setPopulationContext(context: string): void {
    this.populationContext = context;
  }

  // ── Reflection data blocks ──────────────────────────────────────────

  /**
   * Build a state block with drive levels, energy trend, memory distribution,
   * and config version. Data, not instructions.
   */
  private buildStateBlock(): string {
    const parts: string[] = [];

    // Drive levels with direction arrows
    const driveEntries = DRIVE_NAMES.map((n) => {
      const level = this.state.drives.drives[n].level;
      let arrow = "→";
      if (this.previousDriveLevels) {
        const prev = this.previousDriveLevels[n];
        const delta = level - prev;
        if (delta > 0.01) arrow = "↑";
        else if (delta < -0.01) arrow = "↓";
      }
      return `${n}: ${level.toFixed(2)}${arrow}`;
    });
    parts.push(`Drives: ${driveEntries.join(", ")}`);

    // Energy trend: last 5 cycles net
    const history = this.state.energy.cycleHistory;
    if (history.length > 0) {
      const recent = history.slice(-5);
      const trend = recent.map((c) => (c.net >= 0 ? `+${c.net}` : String(c.net)));
      parts.push(`Energy trend (last ${recent.length} cycles net): ${trend.join(", ")}`);
    }

    // Memory type distribution
    const mems = this.state.memories.memories;
    const counts = { procedural: 0, semantic: 0, episodic: 0 };
    for (const m of mems) counts[m.type as keyof typeof counts]++;
    parts.push(`Memory distribution: ${counts.procedural} procedural, ${counts.semantic} semantic, ${counts.episodic} episodic`);

    // Config version + cycles since last rewrite
    const version = this.state.config.version;
    if (version > 0) {
      const lastRewrite = this.state.config.promptHistory[this.state.config.promptHistory.length - 1];
      if (lastRewrite) {
        const cyclesSince = this.state.cycleCount - lastRewrite.version;
        parts.push(`Config version: ${version} (last rewrite: ${cyclesSince} cycles ago)`);
      } else {
        parts.push(`Config version: ${version}`);
      }
    }

    return `State:\n- ${parts.join("\n- ")}`;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function formatDrives(drives: DriveSystem): string {
  return Object.values(drives.drives)
    .map((d) => `${d.name}: ${d.level.toFixed(2)} (threshold: ${d.threshold})`)
    .join(", ");
}
