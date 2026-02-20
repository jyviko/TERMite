import Anthropic from "@anthropic-ai/sdk";
import type { AgentEvent, MemoryType, SkillEntry } from "../types/index.js";
import type { Brain } from "../brain/index.js";
import { extractText } from "../brain/util.js";
import type { Executor } from "../executor/index.js";
import { OrganismStateManager } from "../state/organism-state.js";
import { AgenticLoop, type ToolExecutor } from "./agentic-loop.js";
import { Resolver, computeIncome } from "./resolve.js";
import { Memorizer } from "./memorize.js";

const MEMORY_TOKEN_BUDGET = 2000;
const STALE_SKILL_MAX_AGE = 50;

export class OrganismStateMachine {
  private loop: AgenticLoop;
  private resolver: Resolver;
  private memorizer: Memorizer;
  private forageMessages: Anthropic.MessageParam[] = [];
  private savePath: string;
  private transitionTarget: string | null = null;
  private questReward: number | null = null;

  constructor(
    private brain: Brain,
    private executor: Executor,
    private state: OrganismStateManager,
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

      switch (this.state.mode) {
        case "forage":
          yield* this.forage();
          break;
        case "think":
          yield* this.think();
          break;
        case "rest":
          yield* this.rest();
          break;
      }

      // Post-burst: resolve + memorize
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
    yield { type: "state_change", from: this.state.mode, to: "forage" };
    this.state.mode = "forage";
    this.transitionTarget = null;

    const tools = this.buildForageTools();
    const executor = this.buildToolExecutor();

    // Build awareness message for this burst
    const awareness = this.buildAwarenessMessage();
    if (this.forageMessages.length === 0) {
      this.forageMessages.push(awareness);
    }

    for await (const event of this.loop.run({
      systemPrompt: this.state.genome.systemPrompt,
      messages: this.forageMessages,
      tools,
      model: this.state.genome.routing.forage.model,
      maxTokens: this.state.genome.routing.forage.maxTokens,
      executor,
    })) {
      yield event;

      // Track energy cost from brain responses
      if (event.type === "error") break;

      // Check if transition was requested
      if (this.transitionTarget) break;
    }

    // Handle transition
    if (this.transitionTarget === "think") {
      this.state.mode = "think";
    } else if (this.transitionTarget === "rest") {
      this.state.mode = "rest";
    }
  }

  private async *think(): AsyncGenerator<AgentEvent> {
    yield { type: "state_change", from: this.state.mode, to: "think" };
    this.state.mode = "think";

    const summary = this.buildThinkContext();
    try {
      const response = await this.brain.chat({
        model: this.state.genome.routing.think.model,
        system: "You are the strategic mind. Analyze the situation and form a plan.",
        messages: [{ role: "user", content: summary }],
        maxTokens: this.state.genome.routing.think.maxTokens,
      });

      this.state.energy.burn("think", response.usage.input + response.usage.output);

      const plan = extractText(response.content);

      yield { type: "text", text: plan };

      // Inject plan into forage messages
      this.forageMessages.push({ role: "user", content: `Strategic plan: ${plan}` });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      yield { type: "error", message: `Think failed: ${msg}` };
    }

    this.state.mode = "forage";
  }

  private async *rest(): AsyncGenerator<AgentEvent> {
    yield { type: "state_change", from: this.state.mode, to: "rest" };
    this.state.mode = "rest";

    const summary = this.serializeMessages(this.forageMessages);

    try {
      const response = await this.brain.chat({
        model: this.state.genome.routing.forage.model, // Haiku
        system: this.state.genome.restPrompt,
        messages: [{ role: "user", content: summary }],
        maxTokens: 1024,
      });

      this.state.energy.burn("rest", response.usage.input + response.usage.output);

      const text = extractText(response.content);

      // Parse and store extracted memories
      const extracted = parseRestMemories(text);
      for (const m of extracted) {
        this.state.memories.add(m.content, m.type as MemoryType, m.importance);
      }

      yield { type: "text", text: `REST: extracted ${extracted.length} memories` };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      yield { type: "error", message: `Rest failed: ${msg}` };
    }

    // Prune stale skills
    this.pruneSkills();

    // Decay-evict low-score memories
    this.state.memories.decayEvict();

    // Fresh context
    this.forageMessages = [];
    this.state.mode = "forage";
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

    // Compute income
    const income = computeIncome(result.goalRelevance, result.outcome, this.questReward);
    if (income.amount > 0) {
      this.state.energy.feed(income.amount);
    }
    this.questReward = null;

    // End cycle
    this.state.energy.endCycle(
      this.state.cycleCount,
      result.outcome,
      income.amount,
      income.sources.join(", "),
    );

    yield {
      type: "text",
      text: `RESOLVE: outcome=${result.outcome} relevance=${result.goalRelevance} lesson="${result.lesson}"`,
    };

    // Memorize
    await this.memorizer.memorize({
      genome: this.state.genome,
      memories: this.state.memories,
      lesson: result.lesson,
      outcome: result.outcome,
      goalRelevance: result.goalRelevance,
      actions,
      energy: this.state.energy,
    });

    // Update BMR based on memory cost
    this.state.energy.computeBmr(this.state.memories.totalTokenCost);
  }

  private buildAwarenessMessage(): Anthropic.MessageParam {
    const memories = this.state.memories.format(MEMORY_TOKEN_BUDGET);
    const drives = formatDrives(this.state.drives);
    const activeGoal = this.deriveGoal();

    const parts = [
      `Your memories:\n${memories}`,
      `Energy: ${this.state.energy.remaining}/${this.state.energy.capacity}`,
      `Drives: ${drives}`,
      activeGoal ? `Active drive goal: ${activeGoal}` : null,
      `Cycle: ${this.state.cycleCount} | Generation: ${this.state.generation}`,
    ].filter(Boolean);

    return { role: "user" as const, content: parts.join("\n\n") };
  }

  private deriveGoal(): string | null {
    const drive = this.state.drives.highestActive();
    return drive ? this.state.drives.driveToGoal(drive) : null;
  }

  private buildThinkContext(): string {
    const recent = this.summarizeRecentActions();
    return [
      `Current state:`,
      `  Energy: ${this.state.energy.remaining}/${this.state.energy.capacity}`,
      `  Cycle: ${this.state.cycleCount}`,
      `  Goal: ${this.state.goal ?? this.deriveGoal() ?? "None"}`,
      `  Memories: ${this.state.memories.memories.length}`,
      ``,
      `Recent actions:`,
      recent,
    ].join("\n");
  }

  private buildForageTools(): Anthropic.Tool[] {
    return [
      {
        name: "execute_shell",
        description: "Execute a shell command in your workspace.",
        input_schema: {
          type: "object" as const,
          properties: {
            command: { type: "string", description: "The shell command to run" },
          },
          required: ["command"],
        },
      },
      {
        name: "write_file",
        description: "Write content to a file in your workspace.",
        input_schema: {
          type: "object" as const,
          properties: {
            path: { type: "string", description: "File path relative to /workspace/" },
            content: { type: "string", description: "File content" },
          },
          required: ["path", "content"],
        },
      },
      {
        name: "transition",
        description:
          "Switch to a different cognitive mode. 'think' for deep strategic reasoning (expensive). 'rest' to consolidate memories and free context.",
        input_schema: {
          type: "object" as const,
          properties: {
            mode: { type: "string", enum: ["think", "rest"] },
          },
          required: ["mode"],
        },
      },
      {
        name: "list_skills",
        description:
          "See what reusable scripts you have. Call this after waking up or when you need to remember your capabilities.",
        input_schema: {
          type: "object" as const,
          properties: {},
        },
      },
      {
        name: "check_quest",
        description:
          "Run the verification script for your current quest. Returns PASS or FAIL with feedback.",
        input_schema: {
          type: "object" as const,
          properties: {},
        },
      },
    ];
  }

  private buildToolExecutor(): ToolExecutor {
    return async (name: string, input: Record<string, unknown>): Promise<string> => {
      switch (name) {
        case "execute_shell": {
          const command = String(input.command ?? "");
          return this.executor.executeShell(command);
        }
        case "write_file": {
          const path = String(input.path ?? "");
          const content = String(input.content ?? "");
          return this.executor.writeFile(path, content);
        }
        case "transition": {
          const mode = String(input.mode ?? "");
          if (mode === "think" || mode === "rest") {
            this.transitionTarget = mode;
            return `Transitioning to ${mode} mode`;
          }
          return "Invalid mode. Use 'think' or 'rest'.";
        }
        case "list_skills": {
          try {
            const manifest = await this.executor.executeShell(
              "cat /workspace/skills/manifest.json 2>/dev/null || echo '{}'",
            );
            const skills: Record<string, SkillEntry> = JSON.parse(manifest);
            if (Object.keys(skills).length === 0) return "No skills yet.";
            return Object.entries(skills)
              .map(([k, v]) => `- ${k}: ${v.description}\n  Usage: ${v.usage}`)
              .join("\n");
          } catch {
            return "No skills yet.";
          }
        }
        case "check_quest": {
          try {
            return await this.executor.executeShell("bash /workspace/quests/verify.sh 2>&1");
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return `Quest verification failed: ${msg}`;
          }
        }
        default:
          return `Unknown tool: ${name}`;
      }
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

  private pruneSkills(): void {
    // Skills pruning is mechanical — happens during rest
    // The organism's manifest is in the container, so we just fire and forget
    this.executor.executeShell(
      `node -e "
        const fs = require('fs');
        const path = '/workspace/skills/manifest.json';
        try {
          const m = JSON.parse(fs.readFileSync(path, 'utf-8'));
          const cycle = ${this.state.cycleCount};
          const maxAge = ${STALE_SKILL_MAX_AGE};
          const pruned = {};
          for (const [k, v] of Object.entries(m)) {
            if (cycle - v.lastUsed < maxAge) pruned[k] = v;
            else try { fs.unlinkSync('/workspace/skills/' + v.path); } catch {}
          }
          fs.writeFileSync(path, JSON.stringify(pruned, null, 2));
        } catch {}
      "`,
    ).catch(() => {
      // Non-fatal
    });
  }

  // Allow arena to set quest reward
  setQuestReward(reward: number): void {
    this.questReward = reward;
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
