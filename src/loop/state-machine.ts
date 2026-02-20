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
    description: "Store for future recall.",
    input_schema: {
      type: "object" as const,
      properties: { input: { type: "string" } },
    },
  },
];
const INTERNAL_TOOL_NAMES = new Set(INTERNAL_TOOLS.map((t) => t.name));

// Outcome priority for multi-resolve cycles: keep the best
const OUTCOME_RANK: Record<Outcome, number> = {
  success: 3,
  partial: 2,
  uncertain: 1,
  failure: 0,
};

export class OrganismStateMachine {
  private loop: AgenticLoop;
  private resolver: Resolver;
  private savePath: string;
  private taskReward: number | null = null;
  private taskTier: number | null = null;
  private consecutiveIdleCycles = 0;
  private cycleModel = "";
  private static readonly STALENESS_THRESHOLD = 5;

  // Per-cycle income tracking (accumulated across resolve calls)
  private cycleIncome = 0;
  private cycleSources: string[] = [];
  private cycleOutcome: Outcome | null = null;
  private cycleRelevance = 0;

  // Action log built from yielded events during cycle
  private cycleActions: string[] = [];

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

  async *run(): AsyncGenerator<AgentEvent> {
    while (this.state.alive) {
      this.state.energy.burnBmr();
      if (!this.state.checkVitalSigns()) {
        break;
      }

      // Reset per-cycle tracking
      this.cycleIncome = 0;
      this.cycleSources = [];
      this.cycleOutcome = null;
      this.cycleRelevance = 0;
      this.cycleActions = [];

      yield* this.cycle();

      // Cycle-end housekeeping
      this.state.energy.endCycle(
        this.state.cycleCount,
        this.cycleOutcome,
        this.cycleIncome,
        this.cycleSources.join(", "),
        this.cycleRelevance,
        this.cycleModel,
      );

      this.state.memories.decayEvict();
      this.state.energy.computeBmr(this.state.memories.totalTokenCost);
      this.state.drives.update(
        this.state.energy,
        this.state.memories.memories,
        this.state.cycleCount,
      );
      this.state.cycleCount++;
      await this.state.save(this.savePath);
    }

    if (!this.state.alive) {
      yield { type: "state_change", from: this.state.mode, to: "dead" };
    }
  }

  private lastToolHint = "";

  private async *cycle(): AsyncGenerator<AgentEvent> {
    const routing = this.state.genome.routing[this.state.routing];
    const model = routing.model;
    this.cycleModel = model;
    const maxTokens = routing.maxTokens;

    const tools = await this.buildTools();
    const toolCallCounts = new Map<string, number>();
    const executor = this.buildToolExecutor();
    const trackingExecutor: ToolExecutor = async (name, input) => {
      toolCallCounts.set(name, (toolCallCounts.get(name) ?? 0) + 1);
      return executor(name, input);
    };

    // Build awareness message — organism wakes up knowing who it is
    const messages: Anthropic.MessageParam[] = [this.buildAwarenessMessage()];

    for await (const event of this.loop.run({
      systemPrompt: this.state.genome.systemPrompt,
      messages,
      tools,
      model,
      maxTokens,
      executor: trackingExecutor,
    })) {
      yield event;

      // Track actions from events for summarizeRecentActions
      if (event.type === "tool_start") {
        this.cycleActions.push(`→ ${event.name}`);
      } else if (event.type === "tool_result") {
        this.cycleActions.push(`← ${event.name}: ${event.result.slice(0, 100)}`);
      } else if (event.type === "text") {
        this.cycleActions.push(event.text.slice(0, 150));
      }

      if (event.type === "usage") {
        this.state.energy.burn(model, event);
      }

      if (event.type === "error") break;
    }

    // Compute tool usage hint for next-cycle awareness
    const availableNames = tools.map((t) => t.name);
    this.lastToolHint = buildToolHint(availableNames, toolCallCounts);

    // Track staleness — organism that does nothing useful dies.
    // Internal-only tool calls (think/memorize) don't count as real work.
    const externalCalls = Array.from(toolCallCounts.keys()).filter(
      (name) => !INTERNAL_TOOL_NAMES.has(name),
    );
    if (externalCalls.length > 0) {
      this.consecutiveIdleCycles = 0;
    } else {
      this.consecutiveIdleCycles++;
      if (this.consecutiveIdleCycles >= OrganismStateMachine.STALENESS_THRESHOLD) {
        this.state.die("staleness");
      }
    }
  }

  // ── Internal tool handlers ──────────────────────────────────────────

  private async handleResolve(input: string): Promise<string> {
    const goal = this.state.goal ?? this.deriveGoal() ?? "Explore and survive";
    const actions = input || this.summarizeRecentActions();

    const result = await this.resolver.resolve({
      genome: this.state.genome,
      goal,
      actions,
      energy: this.state.energy,
    });

    // Burn resolver LLM cost
    if (result.usage.output > 0) {
      this.state.energy.burn(this.state.genome.routing.resolve.model, result.usage);
    }

    // Compute income
    const income = await computeIncome(
      result.goalRelevance,
      result.outcome,
      this.taskReward,
      this.teqPool,
      this.state.energy.currentCycleCost,
      this.taskTier ?? undefined,
    );

    // Credit energy
    if (income.base > 0) {
      this.state.energy.feed(income.base);
    }
    if (income.bounty > 0) {
      this.state.energy.feedFromPool(income.bounty);
    }

    // Track for cycle-end accounting
    const totalIncome = income.base + income.bounty;
    this.cycleIncome += totalIncome;
    this.cycleSources.push(...income.sources);

    // Keep best outcome and max relevance across multiple resolve calls
    if (
      this.cycleOutcome === null ||
      OUTCOME_RANK[result.outcome] > OUTCOME_RANK[this.cycleOutcome]
    ) {
      this.cycleOutcome = result.outcome;
    }
    this.cycleRelevance = Math.max(this.cycleRelevance, result.goalRelevance);

    // Clear task reward after first resolve collects it
    this.taskReward = null;
    this.taskTier = null;

    // Return result the organism can see
    const parts = [`earned ${totalIncome} TEQ`, `outcome: ${result.outcome}`];
    if (result.lesson) parts.push(result.lesson);
    return parts.join(". ");
  }

  private handleMemorize(input: string): string {
    if (!input.trim()) return "nothing to memorize";

    const ops = parseMemorizeInput(input);
    const results = applyMemorizeOperations(ops, this.state.memories, this.state.genome);

    if (results.length === 0) return "no valid operations";
    return results.join(", ");
  }

  // ── Tool construction ───────────────────────────────────────────────

  private buildAwarenessMessage(): Anthropic.MessageParam {
    const memories = this.state.memories.format(MEMORY_TOKEN_BUDGET);
    const drives = formatDrives(this.state.drives);
    const activeGoal = this.deriveGoal();

    const lastCycle = this.state.energy.cycleHistory.at(-1);
    const costHint = lastCycle
      ? `Last cycle: cost ${lastCycle.cost} TEQ, earned ${lastCycle.income} TEQ, net ${lastCycle.net > 0 ? "+" : ""}${lastCycle.net} TEQ`
      : null;

    const parts = [
      `Your memories:\n${memories}`,
      `Energy: ${this.state.energy.remaining}/${this.state.energy.capacity}`,
      `Drives: ${drives}`,
      activeGoal ? `Active drive goal: ${activeGoal}` : null,
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

    // Discover workspace tools from container
    try {
      const listing = await this.executor.executeShell(
        "find /workspace/tools -maxdepth 1 -type f -executable 2>/dev/null || true",
      );
      for (const line of listing.trim().split("\n")) {
        if (!line) continue;
        const filename = line.split("/").pop()!;
        const name = filename.replace(/\.[^.]+$/, "");
        // Don't shadow internal tools
        if (INTERNAL_TOOL_NAMES.has(name)) continue;
        tools.push({
          name,
          description: filename,
          input_schema: {
            type: "object" as const,
            properties: {
              input: { type: "string" },
            },
          },
        });
      }
    } catch {
      // Container not ready or no tools yet
    }

    // Append internal tools
    tools.push(...INTERNAL_TOOLS);

    return tools;
  }

  private buildToolExecutor(): ToolExecutor {
    return async (name: string, input: Record<string, unknown>): Promise<string> => {
      const toolInput = String(input.input ?? "");

      switch (name) {
        case "think":
          return toolInput;
        case "resolve":
          return this.handleResolve(toolInput);
        case "memorize":
          return this.handleMemorize(toolInput);
        default: {
          // Workspace tool — execute in container
          const escaped = toolInput.replace(/'/g, "'\\''");
          return this.executor.executeShell(`/workspace/tools/${name} '${escaped}'`);
        }
      }
    };
  }

  private summarizeRecentActions(): string {
    if (this.cycleActions.length === 0) return "(no actions)";
    // Take the last 20 entries for a concise summary
    return this.cycleActions.slice(-20).join("\n");
  }

  // Allow arena to set task reward and tier
  setTaskReward(reward: number, tier: number): void {
    this.taskReward = reward;
    this.taskTier = tier;
  }
}

function formatDrives(drives: DriveSystem): string {
  return Object.values(drives.drives)
    .map((d) => `${d.name}: ${d.level.toFixed(2)} (threshold: ${d.threshold})`)
    .join(", ");
}

function buildToolHint(available: string[], used: Map<string, number>): string {
  if (available.length === 0) return "";

  const parts: string[] = [];

  if (used.size === 0) {
    parts.push("Tools: none used this cycle");
    parts.push(`Available: ${available.join(", ")}`);
  } else {
    const usedSummary = Array.from(used.entries())
      .map(([name, count]) => `${name}(${count})`)
      .join(", ");
    parts.push(`Tools used: ${usedSummary}`);

    const unused = available.filter((t) => !used.has(t));
    if (unused.length > 0) {
      parts.push(`Unused tools: ${unused.join(", ")}`);
    }
  }

  return parts.join(" | ");
}
