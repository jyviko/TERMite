import Anthropic from "@anthropic-ai/sdk";
import type { AgentEvent, MemoryType } from "../types/index.js";
import type { Brain } from "../brain/index.js";
import { extractText } from "../brain/util.js";
import type { Executor } from "../executor/index.js";
import { OrganismStateManager } from "../state/organism-state.js";
import { AgenticLoop, type ToolExecutor } from "./agentic-loop.js";
import { Resolver, computeIncome } from "./resolve.js";
import { Memorizer } from "./memorize.js";
import type { TEQPool } from "../arena/teq-pool.js";

const MEMORY_TOKEN_BUDGET = 2000;

export class OrganismStateMachine {
  private loop: AgenticLoop;
  private resolver: Resolver;
  private memorizer: Memorizer;
  private forageMessages: Anthropic.MessageParam[] = [];
  private savePath: string;
  private taskReward: number | null = null;
  private taskTier: number | null = null;
  private consecutiveIdleCycles = 0;
  private forageModel = "";
  private static readonly STALENESS_THRESHOLD = 5;

  constructor(
    private brain: Brain,
    private executor: Executor,
    private state: OrganismStateManager,
    private teqPool: TEQPool,
    savePath?: string,
  ) {
    this.loop = new AgenticLoop(brain);
    this.resolver = new Resolver(brain);
    this.memorizer = new Memorizer(brain);
    this.savePath = savePath ?? `saves/${state.id}.json`;
  }

  async *run(): AsyncGenerator<AgentEvent> {
    while (this.state.alive) {
      this.state.energy.burnBmr();
      if (!this.state.checkVitalSigns()) {
        yield { type: "state_change", from: this.state.mode, to: "dead" };
        break;
      }

      yield* this.forage();

      // Post-burst: resolve + memorize + rest
      yield* this.postBurst();

      this.state.drives.update(
        this.state.energy,
        this.state.memories.memories,
        this.state.cycleCount,
      );
      this.state.cycleCount++;
      await this.state.save(this.savePath);
    }
  }

  private async *forage(): AsyncGenerator<AgentEvent> {
    const routing = this.state.genome.routing[this.state.forageRouting];
    const model = routing.model;
    this.forageModel = model;
    const maxTokens = routing.maxTokens;

    const tools = await this.buildForageTools();
    let toolsUsed = false;
    const executor = this.buildToolExecutor();
    const trackingExecutor: ToolExecutor = async (name, input) => {
      toolsUsed = true;
      return executor(name, input);
    };

    // Build awareness message — organism wakes up knowing who it is
    this.forageMessages = [this.buildAwarenessMessage()];

    for await (const event of this.loop.run({
      systemPrompt: this.state.genome.systemPrompt,
      messages: this.forageMessages,
      tools,
      model,
      maxTokens,
      executor: trackingExecutor,
    })) {
      yield event;

      if (event.type === "usage") {
        this.state.energy.burn(model, event);
      }

      if (event.type === "error") break;
    }

    // Track staleness — organism that does nothing dies
    if (toolsUsed) {
      this.consecutiveIdleCycles = 0;
    } else {
      this.consecutiveIdleCycles++;
      if (this.consecutiveIdleCycles >= OrganismStateMachine.STALENESS_THRESHOLD) {
        this.state.die("staleness");
      }
    }
  }

  private async *postBurst(): AsyncGenerator<AgentEvent> {
    const goal = this.state.goal ?? this.deriveGoal() ?? "Explore and survive";
    const actions = this.summarizeRecentActions();

    // Resolve
    const result = await this.resolver.resolve({
      genome: this.state.genome,
      goal,
      actions,
      energy: this.state.energy,
    });

    // Burn resolve cost (model-weighted)
    if (result.usage.output > 0) {
      this.state.energy.burn(this.state.genome.routing.resolve.model, result.usage);
    }

    // Compute income (withdraws from shared pool)
    const income = await computeIncome(
      result.goalRelevance,
      result.outcome,
      this.taskReward,
      this.teqPool,
      this.state.energy.currentCycleCost,
      this.taskTier ?? undefined,
    );
    if (income.amount > 0) {
      this.state.energy.feedFromPool(income.amount);
    }
    this.taskReward = null;
    this.taskTier = null;

    // End cycle
    this.state.energy.endCycle(
      this.state.cycleCount,
      result.outcome,
      income.amount,
      income.sources.join(", "),
      result.goalRelevance,
      this.forageModel,
    );

    yield {
      type: "text",
      text: `RESOLVE: outcome=${result.outcome} relevance=${result.goalRelevance} lesson="${result.lesson}"`,
    };

    // Memorize
    const memorizeUsage = await this.memorizer.memorize({
      genome: this.state.genome,
      memories: this.state.memories,
      lesson: result.lesson,
      outcome: result.outcome,
      goalRelevance: result.goalRelevance,
      actions,
      energy: this.state.energy,
    });
    if (memorizeUsage.output > 0) {
      this.state.energy.burn(this.state.genome.routing.fast.model, memorizeUsage);
    }

    // Update BMR based on memory cost
    this.state.energy.computeBmr(this.state.memories.totalTokenCost);

    // Rest: compact burst into memories, clear context
    yield* this.rest();
  }

  private async *rest(): AsyncGenerator<AgentEvent> {
    const summary = this.serializeMessages(this.forageMessages);
    if (!summary.trim()) return;

    try {
      const response = await this.brain.chat({
        model: this.state.genome.routing.fast.model,
        system: this.state.genome.restPrompt,
        messages: [{ role: "user", content: summary }],
        maxTokens: 1024,
      });

      this.state.energy.burn(this.state.genome.routing.fast.model, response.usage);

      const extracted = parseRestMemories(extractText(response.content));
      for (const m of extracted) {
        this.state.memories.add(m.content, m.type as MemoryType, m.importance);
      }

      yield { type: "text", text: `REST: extracted ${extracted.length} memories` };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      yield { type: "error", message: `Rest failed: ${msg}` };
    }

    this.state.memories.decayEvict();
    this.forageMessages = [];
  }

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
      `Cycle: ${this.state.cycleCount} | Generation: ${this.state.generation}`,
    ].filter(Boolean);

    return { role: "user" as const, content: parts.join("\n\n") };
  }

  private deriveGoal(): string | null {
    const drive = this.state.drives.highestActive();
    return drive ? this.state.drives.driveToGoal(drive) : null;
  }

  private async buildForageTools(): Promise<Anthropic.Tool[]> {
    const tools: Anthropic.Tool[] = [];

    try {
      const listing = await this.executor.executeShell(
        "find /workspace/tools -maxdepth 1 -type f -executable 2>/dev/null || true",
      );
      for (const line of listing.trim().split("\n")) {
        if (!line) continue;
        const filename = line.split("/").pop()!;
        const name = filename.replace(/\.[^.]+$/, "");
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

    return tools;
  }

  private buildToolExecutor(): ToolExecutor {
    return async (_name: string, input: Record<string, unknown>): Promise<string> => {
      const toolInput = String(input.input ?? "");
      const escaped = toolInput.replace(/'/g, "'\\''");
      return this.executor.executeShell(`/workspace/tools/${_name} '${escaped}'`);
    };
  }

  private summarizeRecentActions(): string {
    const textEvents: string[] = [];
    for (const msg of this.forageMessages.slice(-10)) {
      if (typeof msg.content === "string") {
        textEvents.push(msg.content.slice(0, 200));
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (typeof block === "object" && "type" in block) {
            if (block.type === "text") {
              textEvents.push((block as { text: string }).text.slice(0, 200));
            } else if (block.type === "tool_use") {
              const tb = block as { name: string; input: unknown };
              textEvents.push(`[tool: ${tb.name}]`);
            } else if (block.type === "tool_result") {
              const tb = block as { content?: string };
              if (typeof tb.content === "string") {
                textEvents.push(`[result: ${tb.content.slice(0, 100)}]`);
              }
            }
          }
        }
      }
    }
    return textEvents.join("\n") || "(no actions)";
  }

  private serializeMessages(messages: Anthropic.MessageParam[]): string {
    const lines: string[] = [];
    for (const msg of messages) {
      if (typeof msg.content === "string") {
        lines.push(`[${msg.role}] ${msg.content}`);
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (typeof block === "object" && "type" in block) {
            if (block.type === "text") {
              lines.push(`[${msg.role}] ${(block as { text: string }).text}`);
            } else if (block.type === "tool_use") {
              const tb = block as { name: string; input: unknown };
              lines.push(`[${msg.role}] tool: ${tb.name}(${JSON.stringify(tb.input)})`);
            } else if (block.type === "tool_result") {
              const tb = block as { content?: string };
              lines.push(`[${msg.role}] result: ${typeof tb.content === "string" ? tb.content : ""}`);
            }
          }
        }
      }
    }
    return lines.join("\n");
  }

  // Allow arena to set task reward and tier
  setTaskReward(reward: number, tier: number): void {
    this.taskReward = reward;
    this.taskTier = tier;
  }
}

function formatDrives(drives: import("../state/drives.js").DriveSystem): string {
  return Object.values(drives.drives)
    .map((d) => `${d.name}: ${d.level.toFixed(2)} (threshold: ${d.threshold})`)
    .join(", ");
}

function parseRestMemories(
  text: string,
): Array<{ content: string; type: string; importance: number }> {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return [];
    const parsed = JSON.parse(jsonMatch[0]);
    if (Array.isArray(parsed.memories)) {
      return parsed.memories.filter(
        (m: unknown) =>
          typeof m === "object" &&
          m !== null &&
          "content" in m &&
          "type" in m &&
          "importance" in m,
      );
    }
    return [];
  } catch {
    return [];
  }
}
