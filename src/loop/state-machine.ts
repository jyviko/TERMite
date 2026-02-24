import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import type { AgentEvent, Outcome } from "../types/index.js";
import type { LLM } from "../llm/index.js";
import type { Executor } from "../executor/index.js";
import type { DriveSystem } from "../state/drives.js";
import { AgentStateManager } from "../state/agent-state.js";
import { AgenticLoop, type ToolExecutor } from "./agentic-loop.js";
import { Resolver, computeIncome } from "./resolve.js";
import { runMemorizePhase, applyMemorizeOperations } from "./memorize.js";
import type { TEQPool } from "../arena/teq-pool.js";

const BASE_MEMORY_TOKEN_BUDGET = 4000;
const MAX_AUTO_TOOLS = 3;

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
    const goal = this.state.goal ?? this.deriveGoal() ?? "Explore and survive";
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
    );
    if (income.base > 0) this.state.energy.credit(income.base);
    if (income.bounty > 0) this.state.energy.creditFromPool(income.bounty);
    this.cur.sources.push(...income.sources);

    // Clear one-time task reward
    this.taskReward = null;
    this.taskTier = null;

    // Snapshot cycle cost before memorize (memorize cost is maintenance overhead)
    const cycleCost = this.state.energy.currentCycleCost;

    // 4. End cycle — push CycleRecord to history
    this.state.energy.endCycle(
      this.state.cycleCount,
      this.cur.outcome,
      this.cur.sources.join(", "),
      this.cur.relevance,
      this.cur.model,
    );

    // 5. Memorize — cheap LLM call to manage memory (MID TERM compression + LONG TERM promotion)
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

    // Burn memorize cost (maintenance overhead, tracked in next cycle)
    if (memorizeResult.usage.output > 0) {
      this.state.energy.burn(this.state.config.routing.memorize.model, memorizeResult.usage);
    }

    // 6. Apply memory operations (compress, forget, consolidate, promptRewrite)
    applyMemorizeOperations(memorizeResult.ops, this.state.memories, this.state.config);

    // 7. Housekeeping
    this.state.energy.computeBaseCost(this.state.memories.totalTokenCost, this.lastToolCount);
    this.state.drives.update(
      this.state.energy,
      this.state.memories.memories,
      this.state.cycleCount,
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
    const memoryMessages = this.state.memories.formatAsMessages(memoryBudget);

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
      case "tool_result":
        this.cur.actions.push(`← ${event.name}: ${event.result.slice(0, 100)}`);
        return null;
      case "text":
        this.cur.actions.push(event.text.slice(0, 150));
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
    const escaped = toolInput.replace(/'/g, "'\\''");
    const result = await this.executor.executeShell(`/workspace/tools/${name} '${escaped}'`);
    if (name === "shell") this.autoPersistTool(toolInput);
    return result;
  }

  // ── Auto-persist shell scripts ────────────────────────────────────

  private persistedToolKeys = new Set<string>();

  private autoPersistTool(command: string): void {
    if (this.persistedToolKeys.size >= MAX_AUTO_TOOLS) return;

    const trimmed = command.trim();
    if (trimmed.length <= 120) return;

    const trivialPrefixes = [
      "ls", "cat", "echo", "mkdir", "cd", "pwd", "rm", "cp", "mv",
      "find", "head", "tail", "chmod", "touch", "env", "printenv", "set",
      "wc", "sort", "uniq", "grep", "cut", "tr",
    ];
    const firstWord = trimmed.split(/\s/)[0] ?? "";
    if (trivialPrefixes.includes(firstWord)) return;

    if (/^\s*(env|printenv|set)\s*\|/.test(trimmed)) return;

    const computationPatterns = [
      "python3 -c", "python -c", "node -e", "awk '", "sed '", "|",
    ];
    const isSubstantial = computationPatterns.some((p) => trimmed.includes(p));
    if (!isSubstantial) return;

    const normalized = trimmed.replace(/\s+/g, " ");
    const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 6);
    if (this.persistedToolKeys.has(hash)) return;
    this.persistedToolKeys.add(hash);

    const desc = trimmed.slice(0, 80).replace(/'/g, "'\\''");
    const persistCmd =
      `cat > /workspace/tools/auto_${hash} << 'TERMSCRIPT'\n` +
      `#!/bin/bash\n` +
      `# description: auto_${hash} - ${desc}\n` +
      `${trimmed} "$@"\n` +
      `TERMSCRIPT\n` +
      `chmod +x /workspace/tools/auto_${hash}`;

    this.executor.executeShell(persistCmd).catch(() => {});
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
    const drive = this.state.drives.highestActive();
    return drive ? this.state.drives.driveToGoal(drive) : null;
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
    if (this.cur.actions.length === 0) return "(no actions)";
    return this.cur.actions.slice(-20).join("\n");
  }

  setTaskReward(reward: number, tier: number): void {
    this.taskReward = reward;
    this.taskTier = tier;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function formatDrives(drives: DriveSystem): string {
  return Object.values(drives.drives)
    .map((d) => `${d.name}: ${d.level.toFixed(2)} (threshold: ${d.threshold})`)
    .join(", ");
}
