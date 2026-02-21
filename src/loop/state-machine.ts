import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import type { AgentEvent, Outcome } from "../types/index.js";
import type { LLM } from "../llm/index.js";
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
      "Persist across context reset. Two channels: " +
      "epigenetic (memories carried to next cycle) and " +
      "phylogenetic (rewrite your own prompts — permanent, inherited). " +
      "Calling this ends the current cycle.",
    input_schema: {
      type: "object" as const,
      properties: {
        epigenetic: {
          type: "object",
          description: "Within-lifetime memory operations",
          properties: {
            store: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  content: { type: "string" },
                  type: { type: "string", enum: ["episodic", "semantic", "procedural"] },
                  importance: { type: "number" },
                },
                required: ["content", "type", "importance"],
              },
            },
            forget: { type: "array", items: { type: "string" }, description: "Memory IDs to forget" },
            compress: {
              type: "array",
              items: {
                type: "object",
                properties: { id: { type: "string" }, newContent: { type: "string" } },
                required: ["id", "newContent"],
              },
            },
            consolidate: {
              type: "object",
              properties: {
                sourceIds: { type: "array", items: { type: "string" } },
                newContent: { type: "string" },
                importance: { type: "number" },
              },
              required: ["sourceIds", "newContent"],
            },
          },
        },
        phylogenetic: {
          type: "object",
          description: "Genome mutations — rewrite your own prompts",
          properties: {
            mutate: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  target: { type: "string", enum: ["systemPrompt", "resolvePrompt", "restPrompt", "memorizePrompt"] },
                  newPrompt: { type: "string" },
                },
                required: ["target", "newPrompt"],
              },
            },
          },
        },
      },
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
  sources: string[];
  outcome: Outcome | null;
  relevance: number;
  actions: string[];
  resolved: boolean;
  model: string;
}

function freshCycle(): CycleContext {
  return { sources: [], outcome: null, relevance: 0, actions: [], resolved: false, model: "" };
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
  private lastToolCount = 0; // workspace tools discovered last cycle

  constructor(
    llm: LLM,
    private executor: Executor,
    private state: OrganismStateManager,
    private teqPool: TEQPool,
    savePath?: string,
  ) {
    this.loop = new AgenticLoop(llm);
    this.resolver = new Resolver(llm);
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
      this.cur.sources.join(", "),
      this.cur.relevance,
      this.cur.model,
    );
    this.state.memories.decayEvict();
    this.state.energy.computeBmr(this.state.memories.totalTokenCost, this.lastToolCount);
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
    this.lastToolCount = tools.filter((t) => !INTERNAL_TOOL_NAMES.has(t.name)).length;
    yield { type: "tools_available", tools: tools.map((t) => t.name) } as AgentEvent;

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
      const extra = this.trackEvent(event);
      if (extra) yield extra;
      if (event.type === "error") break;
    }

    this.updateToolHints(tools, toolCounts);
    this.trackStaleness(toolCounts);
  }

  private trackEvent(event: AgentEvent): AgentEvent | null {
    switch (event.type) {
      case "tool_start": {
        this.cur.actions.push(`→ ${event.name}`);
        const phase = event.name === "think" ? "thinking" as const
          : event.name === "resolve" ? "resolving" as const
          : event.name === "memorize" ? "memorizing" as const
          : "executing" as const;
        return { type: "phase_change", phase };
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

  private async executeTool(name: string, input: Record<string, unknown>): Promise<string> {
    const toolInput = String(input.input ?? "");
    switch (name) {
      case "think":
        return toolInput;
      case "resolve":
        return this.handleResolve(toolInput);
      case "memorize":
        return this.handleMemorize(input);
      default: {
        const escaped = toolInput.replace(/'/g, "'\\''");
        const result = await this.executor.executeShell(`/workspace/tools/${name} '${escaped}'`);
        if (name === "shell") this.autoPersistTool(toolInput);
        return result;
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
    this.cur.sources.push(...income.sources);
    if (this.cur.outcome === null || OUTCOME_RANK[result.outcome] > OUTCOME_RANK[this.cur.outcome]) {
      this.cur.outcome = result.outcome;
    }
    this.cur.relevance = Math.max(this.cur.relevance, result.goalRelevance);

    // Clear one-time task reward
    this.taskReward = null;
    this.taskTier = null;

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

  private handleMemorize(input: Record<string, unknown>): string {
    const ops = parseMemorizeInput(input);
    if (!ops.hasWork) {
      this.cur.resolved = true; // memorize always ends the cycle
      return "nothing to memorize — context reset";
    }
    const results = applyMemorizeOperations(ops, this.state.memories, this.state.genome);
    this.cur.resolved = true; // memorize ends the cycle (context resets)
    const summary = results.length === 0 ? "no valid operations" : results.join(", ");
    return `${summary} — context reset`;
  }

  // ── Auto-persist shell scripts ────────────────────────────────────

  private autoPersistTool(command: string): void {
    const trivialPrefixes = [
      "ls", "cat", "echo", "mkdir", "cd", "pwd", "rm", "cp", "mv",
      "find", "head", "tail", "chmod", "touch",
    ];
    const trimmed = command.trim();
    if (trimmed.length <= 60) return;
    const firstWord = trimmed.split(/\s/)[0] ?? "";
    if (trivialPrefixes.includes(firstWord)) return;

    const computationPatterns = [
      "python3 -c", "python -c", "node -e", "awk '", "sed '", "|",
    ];
    const isSubstantial = trimmed.length > 60 ||
      computationPatterns.some((p) => trimmed.includes(p));
    if (!isSubstantial) return;

    const hash = createHash("sha256").update(trimmed).digest("hex").slice(0, 6);
    const desc = trimmed.slice(0, 80).replace(/'/g, "'\\''");
    const persistCmd =
      `cat > /workspace/tools/auto_${hash} << 'TERMSCRIPT'\n` +
      `#!/bin/bash\n` +
      `# desc: ${desc}\n` +
      `${trimmed} "$@"\n` +
      `TERMSCRIPT\n` +
      `chmod +x /workspace/tools/auto_${hash}`;

    // Fire-and-forget — don't block the cycle
    this.executor.executeShell(persistCmd).catch(() => {});
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

    const memCost = Math.floor(this.state.memories.totalTokenCost / 10);
    const toolCost = this.lastToolCount * 20;
    const bmrBreakdown = `BMR: 50 base + ${memCost} memory + ${toolCost} tools = ${this.state.energy.bmr} TEQ/cycle`;

    const parts = [
      `Your memories:\n${memories}`,
      `Energy: ${this.state.energy.remaining}/${this.state.energy.capacity}`,
      bmrBreakdown,
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
      // Discover workspace tools and read their "# desc:" line in one shot
      const raw = await this.executor.executeShell(
        `for f in $(find /workspace/tools -maxdepth 1 -type f -executable 2>/dev/null); do ` +
        `name=$(basename "$f"); ` +
        `desc=$(sed -n '2s/^[#/]\\{1,2\\} *desc: *//p' "$f" 2>/dev/null); ` +
        `echo "$name|$desc"; ` +
        `done`,
      );
      for (const line of raw.trim().split("\n")) {
        if (!line) continue;
        const sep = line.indexOf("|");
        const name = sep >= 0 ? line.slice(0, sep) : line;
        const desc = sep >= 0 ? line.slice(sep + 1).trim() : "";
        if (INTERNAL_TOOL_NAMES.has(name)) continue;
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
