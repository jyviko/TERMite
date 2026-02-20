import type { Outcome, MemoryType } from "../types/index.js";
import type { Brain, TokenUsage } from "../brain/index.js";
import { extractText } from "../brain/util.js";
import type { Genome } from "../state/genome.js";
import type { MemoryStore } from "../state/memory.js";
import type { EnergyLedger } from "../state/energy.js";

const ZERO_USAGE: TokenUsage = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };

export class Memorizer {
  constructor(private brain: Brain) {}

  async memorize(params: {
    genome: Genome;
    memories: MemoryStore;
    lesson: string;
    outcome: Outcome;
    goalRelevance: number;
    actions: string;
    energy: EnergyLedger;
  }): Promise<TokenUsage> {
    const prompt = params.genome.memorizePrompt
      .replace("{actions}", params.actions)
      .replace("{lesson}", params.lesson)
      .replace("{outcome}", params.outcome)
      .replace("{goalRelevance}", String(params.goalRelevance))
      .replace("{remaining}", String(params.energy.remaining))
      .replace("{capacity}", String(params.energy.capacity))
      .replace("{memories}", params.memories.format(2000))
      .replace("{systemPrompt}", params.genome.systemPrompt)
      .replace("{resolvePrompt}", params.genome.resolvePrompt)
      .replace("{restPrompt}", params.genome.restPrompt);

    try {
      const response = await this.brain.chat({
        model: params.genome.routing.fast.model, // Haiku — cheap
        system: prompt,
        messages: [{ role: "user", content: "Reflect and decide what to learn." }],
        maxTokens: 1024,
      });

      const text = extractText(response.content);

      const ops = parseMemorizeResponse(text);
      this.applyOperations(ops, params.memories, params.genome);

      params.memories.decayEvict();
      return response.usage;
    } catch {
      // Memorize failure is non-fatal — organism just doesn't learn this cycle
    }

    params.memories.decayEvict();
    return ZERO_USAGE;
  }

  private applyOperations(
    ops: MemorizeOperations,
    memories: MemoryStore,
    genome: Genome,
  ): void {
    // Store new memories
    if (ops.store) {
      for (const m of ops.store) {
        if (m.content && m.type && typeof m.importance === "number") {
          memories.add(m.content, m.type as MemoryType, m.importance);
        }
      }
    }

    // Forget memories by ID
    if (ops.forget) {
      for (const id of ops.forget) {
        memories.forget(id);
      }
    }

    // Compress memories
    if (ops.compress) {
      for (const c of ops.compress) {
        if (c.id && c.newContent) {
          memories.compress(c.id, c.newContent);
        }
      }
    }

    // Consolidate memories
    if (ops.consolidate) {
      const { sourceIds, newContent, importance } = ops.consolidate;
      if (sourceIds?.length && newContent) {
        memories.consolidate(sourceIds, newContent, importance ?? 0.5);
      }
    }

    // Self-mutation — accepts an array or a single object for backward compat
    if (ops.mutate) {
      const mutations = Array.isArray(ops.mutate) ? ops.mutate : [ops.mutate];
      for (const m of mutations) {
        if (m.target && m.newPrompt?.trim()) {
          genome.mutate(m.target, m.newPrompt);
        }
      }
    }
  }
}

interface MutateOp {
  target: string;
  newPrompt: string;
}

interface MemorizeOperations {
  store?: Array<{ content: string; type: string; importance: number }>;
  forget?: string[];
  compress?: Array<{ id: string; newContent: string }>;
  consolidate?: {
    sourceIds: string[];
    newContent: string;
    importance?: number;
  };
  mutate?: MutateOp | MutateOp[];
}

function parseMemorizeResponse(text: string): MemorizeOperations {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return {};
    return JSON.parse(jsonMatch[0]);
  } catch {
    return {};
  }
}
