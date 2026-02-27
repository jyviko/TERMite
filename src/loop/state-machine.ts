import Anthropic from "@anthropic-ai/sdk";
import { appendFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import type { AgentEvent, CycleRecord, Outcome } from "../types/index.js";
import type { LLM } from "../llm/index.js";
import type { Executor } from "../executor/index.js";
import type { DriveSystem } from "../state/drives.js";
import { AgentStateManager } from "../state/agent-state.js";
import { AgenticLoop, type ToolExecutor } from "./agentic-loop.js";
import { Resolver, computeIncome } from "./resolve.js";
import { runMemorizePhase, applyMemorizeOperations } from "./memorize.js";
import type { TEQPool } from "../arena/teq-pool.js";

const BASE_MEMORY_TOKEN_BUDGET = 4000;

// ── Per-cycle mutable state ─────────────────────────────────────────

interface CycleContext {
  sources: string[];
  outcome: Outcome | null;
  relevance: number;
  actions: string[];
  model: string;
}

function freshCycle(): CycleContext {
  return { sources: [], outcome: null, relevance: 0, actions: [], model: "" };
}

// ── State machine ───────────────────────────────────────────────────

export class AgentStateMachine {
  private llm: LLM;
  private loop: AgenticLoop;
  private resolver: Resolver;
  private savePath: string;

  // Task reward (set by arena, cleared after first resolve)
  private taskReward: number | null = null;
  private taskTier: number | null = null;

  // Internal verify script — never exposed to agents
  private verifyScript: string | null = null;

  // Fork handler — provided by arena, called when agent uses fork tool
  private forkHandler: (() => Promise<string>) | null = null;

  // Signal handler — provided by arena, called when agent uses signal tool
  private signalHandler: ((message: string) => Promise<string>) | null = null;

  // Current cycle
  private cur = freshCycle();
  private lastToolCount = 0;

  constructor(
    llm: LLM,
    private executor: Executor,
    private state: AgentStateManager,
    private teqPool: TEQPool,
    savePath?: string,
  ) {
    this.llm = llm;
    this.loop = new AgenticLoop(llm);
    this.resolver = new Resolver(llm);
    this.savePath = savePath ?? `saves/${state.id}.json`;
  }

  // ── Lifecycle loop ──────────────────────────────────────────────────

  async *run(): AsyncGenerator<AgentEvent> {
    while (this.state.active) {
      this.state.energy.burnBaseCost();
      if (!this.state.checkVitalSigns()) break;

      this.cur = freshCycle();
      yield* this.cycle();
      yield* this.finalizeCycle();
      await this.state.save(this.savePath);
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

    // 1. Resolve — cheap LLM call to judge the cycle
    yield { type: "phase_change", phase: "resolving" };
    const resolveResult = await this.resolver.resolve({
      config: this.state.config,
      goal,
      actions,
      cycleCost: this.state.energy.currentCycleCost,
    });

    // Burn resolve cost
    if (resolveResult.usage.output > 0) {
      this.state.energy.burn(this.state.config.routing.resolve.model, resolveResult.usage);
    }

    // Update cycle context from resolve
    this.cur.outcome = resolveResult.outcome;
    this.cur.relevance = resolveResult.goalRelevance;

    // 2. Store cycle as user/agent memory pair (SHORT TERM — accumulates)
    const context = `Cycle ${this.state.cycleCount}. Goal: ${goal}. Energy: ${this.state.energy.remaining}/${this.state.energy.capacity}`;
    const cycleContent = `${actions}\nOutcome: ${resolveResult.outcome}. Lesson: ${resolveResult.lesson}`;
    const importance = resolveResult.outcome === "success" ? 0.9
      : resolveResult.outcome === "partial" ? 0.7
      : 0.5;
    this.state.memories.add(cycleContent, "episodic", importance, context);

    // 3. Compute and credit income
    const income = await computeIncome(
      resolveResult.goalRelevance,
      resolveResult.outcome,
      this.taskReward,
      this.teqPool,
      this.state.energy.currentCycleCost,
      this.taskTier ?? undefined,
      this.cur.model,
      this.state.id,
    );
    if (income.base > 0) this.state.energy.credit(income.base);
    if (income.bounty > 0) this.state.energy.creditFromPool(income.bounty);
    this.cur.sources.push(...income.sources);

    // Clear one-time task reward
    this.taskReward = null;
    this.taskTier = null;

    // 4. Memorize — cheap LLM call to manage memory (MID TERM compression + LONG TERM promotion)
    yield { type: "phase_change", phase: "memorizing" };
    const memorizeBudget = BASE_MEMORY_TOKEN_BUDGET + Math.floor(this.state.energy.earned / 200);
    const memorizeResult = await runMemorizePhase(
      this.llm,
      this.state.config,
      this.state.memories,
      resolveResult.lesson,
      resolveResult.outcome,
      memorizeBudget,
    );

    // Burn memorize cost (now captured in the current cycle, not the next one)
    if (memorizeResult.usage.output > 0) {
      this.state.energy.burn(this.state.config.routing.memorize.model, memorizeResult.usage);
    }

    // 5. Apply memory operations (compress, forget, consolidate, promptRewrite)
    const oldTokens = this.state.memories.totalTokenCost;
    applyMemorizeOperations(memorizeResult.ops, this.state.memories, this.state.config);
    const newTokens = this.state.memories.totalTokenCost;
    const tokensSaved = oldTokens - newTokens;
    if (tokensSaved > 0) {
      const bonus = Math.floor(tokensSaved * 2);
      this.state.energy.credit(bonus);
      this.cur.sources.push(`consolidation:${bonus}`);
    }

    // 6. End cycle — push CycleRecord to history (after memorize so its cost is included)
    this.state.energy.endCycle(
      this.state.cycleCount,
      this.cur.outcome,
      this.cur.sources.join(", "),
      this.cur.relevance,
      this.cur.model,
    );

    // 6b. Append to metrics.jsonl — SSoT for per-cycle history
    this.appendMetrics();

    // 7. Housekeeping
    this.state.energy.computeBaseCost(this.state.memories.totalTokenCost, this.lastToolCount);
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
    this.cur.model = route.model;

    const tools = await this.buildTools();
    const toolNames = tools.map((t) => t.name);
    this.lastToolCount = tools.length;
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
        route.maxCycleCost != null && this.state.energy.currentCycleCost >= route.maxCycleCost,
      statusNote: () =>
        `Energy: ${this.state.energy.remaining}/${this.state.energy.capacity} TEQ, cycle cost: ${this.state.energy.currentCycleCost} TEQ`,
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
        this.cur.actions.push(`→ ${event.name}`);
        return { type: "phase_change", phase: "executing" as const };
      }
      case "tool_use": {
        // Enrich the preceding tool_start entry with the actual input
        const raw = event.input?.input;
        const inputStr = typeof raw === "string" ? raw.slice(0, 200) : "";
        if (inputStr) {
          const lastIdx = this.cur.actions.length - 1;
          if (lastIdx >= 0 && this.cur.actions[lastIdx]!.startsWith("→")) {
            this.cur.actions[lastIdx] = `→ ${event.name}(${inputStr})`;
          }
        }
        return null;
      }
      case "tool_result":
        this.cur.actions.push(`← ${event.name}: ${event.result.slice(0, 300)}`);

        return null;
      case "text":
        this.cur.actions.push(event.text.slice(0, 300));
        return null;
      case "usage":
        this.state.energy.burn(this.cur.model, event);
        return null;
      default:
        return null;
    }
  }

  // ── Tool execution ────────────────────────────────────────────────

  private async executeTool(name: string, input: Record<string, unknown>): Promise<string> {
    const toolInput = String(input.input ?? "");

    // check is an internal tool — verify script runs host-side, never on agent's filesystem
    if (name === "check" && this.verifyScript) {
      const b64 = Buffer.from(this.verifyScript).toString("base64");
      return this.executor.executeShell(`echo '${b64}' | base64 -d | bash 2>&1`);
    }

    // fork is an internal tool — arena handles the actual split
    if (name === "fork" && this.forkHandler) {
      return this.forkHandler();
    }

    const escaped = toolInput.replace(/'/g, "'\\''");
    const result = await this.executor.executeShell(`/workspace/tools/${name} '${escaped}'`);

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
    if (this.cur.actions.length === 0) return "(no actions taken)";
    return this.cur.actions.slice(-30).join("\n");
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
    const line: CycleRecord & { agentId: string; reserves: number } = {
      ...record,
      agentId: this.state.id,
      reserves: this.state.energy.remaining,
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

  setTaskReward(reward: number, tier: number): void {
    this.taskReward = reward;
    this.taskTier = tier;
  }

  /** Set the internal verify script (run host-side, never visible to agent). */
  setVerifyScript(script: string): void {
    this.verifyScript = script;
  }

  /** Set the fork handler (provided by arena, executed when agent calls fork tool). */
  setForkHandler(handler: () => Promise<string>): void {
    this.forkHandler = handler;
  }

  /** Set the signal handler (provided by arena, executed when agent calls signal tool). */
  setSignalHandler(handler: (message: string) => Promise<string>): void {
    this.signalHandler = handler;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function formatDrives(drives: DriveSystem): string {
  return Object.values(drives.drives)
    .map((d) => `${d.name}: ${d.level.toFixed(2)} (threshold: ${d.threshold})`)
    .join(", ");
}
