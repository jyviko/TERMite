import Anthropic from "@anthropic-ai/sdk";
import type { AgentEvent, Outcome } from "../types/index.js";
import type { Brain } from "../brain/index.js";
import type { Executor } from "../executor/index.js";
import type { DriveSystem } from "../state/drives.js";
import { OrganismStateManager } from "../state/organism-state.js";
import { AgenticLoop, type ToolExecutor } from "./agentic-loop.js";
import { Resolver, computeIncome } from "./resolve.js";
import { parseMemorizeInput, applyMemorizeOperations } from "./memorize.js";
import type { TEQPool } from "../arena/teq-pool.js";

const MEMORY_TOKEN_BUDGET = 2000;

// Internal tools — injected alongside workspace tools.
// Organism sees them in the same flat list, can't read their source.
const INTERNAL_TOOLS: Anthropic.Tool[] = [
  {
    name: "think",
    description: "Returns input unchanged.",
    input_schema: {
      type: "object" as const,
      properties: { input: { type: "string" } },
    },
  },
  {
    name: "resolve",
    description: "Post work for evaluation.",
    input_schema: {
      type: "object" as const,
      properties: { input: { type: "string" } },
    },
  },
  {
    name: "memorize",
    description:
      'Store knowledge for future recall. Plain text is stored as-is. ' +
      'For advanced ops, pass JSON: {"store":[{"content":"...","type":"episodic|semantic|procedural","importance":0.0-1.0}], ' +
      '"forget":["memory_id"], "compress":[{"id":"...","newContent":"..."}], ' +
      '"consolidate":{"sourceIds":[...],"newContent":"...","importance":0.8}, ' +
      '"mutate":[{"target":"systemPrompt","newPrompt":"..."}]}',
    input_schema: {
      type: "object" as const,
      properties: { input: { type: "string" } },
    },
  },
];
const INTERNAL_TOOL_NAMES = new Set(INTERNAL_TOOLS.map((t) => t.name));

const OUTCOME_RANK: Record<Outcome, number> = {
  success: 3,
  partial: 2,
  uncertain: 1,
  failure: 0,
};

// ── Per-cycle mutable state ─────────────────────────────────────────

interface CycleContext {
  income: number;
  sources: string[];
  outcome: Outcome | null;
  relevance: number;
  actions: string[];
  resolved: boolean;
  model: string;
}

function freshCycle(): CycleContext {
  return { income: 0, sources: [], outcome: null, relevance: 0, actions: [], resolved: false, model: "" };
}

// ── State machine ───────────────────────────────────────────────────

export class OrganismStateMachine {
  private loop: AgenticLoop;
  private resolver: Resolver;
  private savePath: string;

  // Task reward (set by arena, cleared after first resolve)
  private taskReward: number | null = null;
  private taskTier: number | null = null;

  // Cross-cycle state
  private consecutiveIdleCycles = 0;
  private lastToolHint = "";
  private knownTools = new Set<string>(INTERNAL_TOOL_NAMES);
  private static readonly STALENESS_THRESHOLD = 5;

  // Current cycle
  private cur = freshCycle();

  constructor(
    private brain: Brain,
    private executor: Executor,
    private state: OrganismStateManager,
    private teqPool: TEQPool,
    savePath?: string,
  ) {
    this.loop = new AgenticLoop(brain);
    this.resolver = new Resolver(brain);
    this.savePath = savePath ?? `saves/${state.id}.json`;
  }

  // ── Lifecycle loop ──────────────────────────────────────────────────

  async *run(): AsyncGenerator<AgentEvent> {
    while (this.state.alive) {
      this.state.energy.burnBmr();
      if (!this.state.checkVitalSigns()) break;

      this.cur = freshCycle();
      yield* this.cycle();
      this.finalizeCycle();
      await this.state.save(this.savePath);
    }

    if (!this.state.alive) {
      await this.state.save(this.savePath);
      yield { type: "state_change", from: this.state.mode, to: "dead" };
    }
  }

  private finalizeCycle(): void {
    this.state.energy.endCycle(
      this.state.cycleCount,
      this.cur.outcome,
      this.cur.income,
      this.cur.sources.join(", "),
      this.cur.relevance,
      this.cur.model,
    );
    this.state.memories.decayEvict();
    this.state.energy.computeBmr(this.state.memories.totalTokenCost);
    this.state.drives.update(
      this.state.energy,
      this.state.memories.memories,
      this.state.cycleCount,
    );
    this.state.cycleCount++;
  }

  // ── Single cycle ──────────────────────────────────────────────────

  private async *cycle(): AsyncGenerator<AgentEvent> {
    const route = this.state.genome.routing.thinking;
    this.cur.model = route.model;

    const tools = await this.buildTools();
    const toolCounts = new Map<string, number>();
    const executor: ToolExecutor = async (name, input) => {
      toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
      return this.executeTool(name, input);
    };

    for await (const event of this.loop.run({
      systemPrompt: this.state.genome.systemPrompt,
      messages: [this.buildAwarenessMessage()],
      tools,
      model: route.model,
      maxTokens: route.maxTokens,
      maxIterations: 25,
      executor,
      shouldStop: () =>
        this.cur.resolved ||
        (route.maxCycleCost != null && this.state.energy.currentCycleCost >= route.maxCycleCost),
      statusNote: () =>
        `Energy: ${this.state.energy.remaining}/${this.state.energy.capacity} TEQ, cycle cost: ${this.state.energy.currentCycleCost} TEQ`,
    })) {
      yield event;
      this.trackEvent(event);
      if (event.type === "error") break;
    }

    this.updateToolHints(tools, toolCounts);
    this.trackStaleness(toolCounts);
  }

  private trackEvent(event: AgentEvent): void {
    switch (event.type) {
      case "tool_start":
        this.cur.actions.push(`→ ${event.name}`);
        break;
      case "tool_result":
        this.cur.actions.push(`← ${event.name}: ${event.result.slice(0, 100)}`);
        break;
      case "text":
        this.cur.actions.push(event.text.slice(0, 150));
        break;
      case "usage":
        this.state.energy.burn(this.cur.model, event);
        break;
    }
  }

  private updateToolHints(tools: Anthropic.Tool[], counts: Map<string, number>): void {
    const names = tools.map((t) => t.name);
    const newTools = names.filter((n) => !this.knownTools.has(n));
    for (const n of names) this.knownTools.add(n);
    this.lastToolHint = formatToolHint(names, counts, newTools);
  }

  private trackStaleness(counts: Map<string, number>): void {
    const hasExternalWork = Array.from(counts.keys()).some((n) => !INTERNAL_TOOL_NAMES.has(n));
    if (hasExternalWork) {
      this.consecutiveIdleCycles = 0;
    } else {
      this.consecutiveIdleCycles++;
      if (this.consecutiveIdleCycles >= OrganismStateMachine.STALENESS_THRESHOLD) {
        this.state.die("staleness");
      }
    }
  }

  // ── Tool execution ────────────────────────────────────────────────

  private executeTool(name: string, input: Record<string, unknown>): Promise<string> {
    const toolInput = String(input.input ?? "");
    switch (name) {
      case "think":
        return Promise.resolve(toolInput);
      case "resolve":
        return this.handleResolve(toolInput);
      case "memorize":
        return Promise.resolve(this.handleMemorize(toolInput));
      default: {
        const escaped = toolInput.replace(/'/g, "'\\''");
        return this.executor.executeShell(`/workspace/tools/${name} '${escaped}'`);
      }
    }
  }

  private async handleResolve(input: string): Promise<string> {
    const goal = this.state.goal ?? this.deriveGoal() ?? "Explore and survive";
    const actions = input || this.summarizeRecentActions();

    const result = await this.resolver.resolve({
      genome: this.state.genome,
      goal,
      actions,
      energy: this.state.energy,
    });

    // Burn resolver cost
    let resolveCost = 0;
    if (result.usage.output > 0) {
      const before = this.state.energy.remaining;
      this.state.energy.burn(this.state.genome.routing.resolve.model, result.usage);
      resolveCost = before - this.state.energy.remaining;
    }

    // Compute and credit income
    const income = await computeIncome(
      result.goalRelevance,
      result.outcome,
      this.taskReward,
      this.teqPool,
      this.state.energy.currentCycleCost,
      this.taskTier ?? undefined,
    );
    if (income.base > 0) this.state.energy.feed(income.base);
    if (income.bounty > 0) this.state.energy.feedFromPool(income.bounty);

    // Track for cycle-end accounting
    const total = income.base + income.bounty;
    this.cur.income += total;
    this.cur.sources.push(...income.sources);
    if (this.cur.outcome === null || OUTCOME_RANK[result.outcome] > OUTCOME_RANK[this.cur.outcome]) {
      this.cur.outcome = result.outcome;
    }
    this.cur.relevance = Math.max(this.cur.relevance, result.goalRelevance);

    // Clear one-time task reward
    this.taskReward = null;
    this.taskTier = null;

    // Signal cycle end
    this.cur.resolved = true;

    const net = total - resolveCost;
    const parts = [
      `earned ${total} TEQ`,
      `resolve cost ${resolveCost} TEQ`,
      `net ${net > 0 ? "+" : ""}${net} TEQ`,
      `outcome: ${result.outcome}`,
    ];
    if (result.lesson) parts.push(result.lesson);
    return parts.join(". ");
  }

  private handleMemorize(input: string): string {
    if (!input.trim()) return "nothing to memorize";
    const ops = parseMemorizeInput(input);
    const results = applyMemorizeOperations(ops, this.state.memories, this.state.genome);
    return results.length === 0 ? "no valid operations" : results.join(", ");
  }

  // ── Awareness & tools ─────────────────────────────────────────────

  private buildAwarenessMessage(): Anthropic.MessageParam {
    const memories = this.state.memories.format(MEMORY_TOKEN_BUDGET);
    const drives = formatDrives(this.state.drives);
    const goal = this.deriveGoal();

    const last = this.state.energy.cycleHistory.at(-1);
    const costHint = last
      ? `Last cycle: cost ${last.cost} TEQ, earned ${last.income} TEQ, net ${last.net > 0 ? "+" : ""}${last.net} TEQ`
      : null;

    const parts = [
      `Your memories:\n${memories}`,
      `Energy: ${this.state.energy.remaining}/${this.state.energy.capacity}`,
      `Drives: ${drives}`,
      goal ? `Active drive goal: ${goal}` : null,
      costHint,
      this.lastToolHint || null,
      `Cycle: ${this.state.cycleCount} | Generation: ${this.state.generation}`,
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
      const listing = await this.executor.executeShell(
        "find /workspace/tools -maxdepth 1 -type f -executable 2>/dev/null || true",
      );
      for (const line of listing.trim().split("\n")) {
        if (!line) continue;
        const filename = line.split("/").pop()!;
        const name = filename.replace(/\.[^.]+$/, "");
        if (INTERNAL_TOOL_NAMES.has(name)) continue;
        tools.push({
          name,
          description: filename,
          input_schema: {
            type: "object" as const,
            properties: { input: { type: "string" } },
          },
        });
      }
    } catch {
      // Container not ready or no tools yet
    }

    tools.push(...INTERNAL_TOOLS);
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

function formatToolHint(available: string[], used: Map<string, number>, newTools: string[] = []): string {
  if (available.length === 0) return "";

  const existing = available.filter((t) => !newTools.includes(t));
  const parts: string[] = [
    `Tools: New: ${newTools.length}, Existing: ${existing.length}`,
  ];

  if (newTools.length > 0) {
    parts.push(`New: ${newTools.join(", ")}`);
  }

  if (used.size === 0) {
    parts.push("None used this cycle");
  } else {
    const summary = Array.from(used.entries())
      .map(([n, c]) => `${n}(${c})`)
      .join(", ");
    parts.push(`Used: ${summary}`);

    const unused = available.filter((t) => !used.has(t));
    if (unused.length > 0) {
      parts.push(`Unused: ${unused.join(", ")}`);
    }
  }

  return parts.join(" | ");
}
