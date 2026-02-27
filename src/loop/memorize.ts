import type { MemoryType } from "../types/index.js";
import { ZERO_USAGE, type LLM, type TokenUsage } from "../llm/index.js";
import { extractText } from "../llm/util.js";
import type { Config } from "../state/config.js";
import type { MemoryStore } from "../state/memory.js";

// ── Operation types ─────────────────────────────────────────────────

interface StoreOp {
  content: string;
  type: string;
  importance: number;
}

interface CompressOp {
  id: string;
  newContent: string;
}

interface ConsolidateOp {
  sourceIds: string[];
  newContent: string;
  importance?: number;
}

export interface MemorizeOps {
  store?: StoreOp[];
  forget?: string[];
  compress?: CompressOp[];
  consolidate?: ConsolidateOp | null;
  promptRewrite?: string | null;
  memorizeRewrite?: string | null;
  resolveRewrite?: string | null;
}

export interface MemorizeResult {
  ops: MemorizeOps;
  usage: TokenUsage;
}

// ── Mandatory memorize phase ────────────────────────────────────────

/**
 * Run the Memorize phase — an LLM call that decides what to remember,
 * forget, compress, consolidate, and whether to rewrite the system prompt.
 */
export async function runMemorizePhase(
  llm: LLM,
  config: Config,
  memories: MemoryStore,
  lesson: string,
  outcome: string,
  memoryBudget: number,
): Promise<MemorizeResult> {
  const prompt = config.memorizePrompt
    .replace("{outcome}", outcome)
    .replace("{lesson}", lesson)
    .replace("{systemPrompt}", config.systemPrompt)
    .replace("{resolvePrompt}", config.resolvePrompt)
    .replace("{memoryCount}", String(memories.memories.length))
    .replace("{memories}", formatMemoriesWithCosts(memories))
    .replace("{memoryTokens}", String(memories.totalTokenCost))
    .replace("{memoryBudget}", String(memoryBudget));

  try {
    const response = await llm.chat({
      model: config.routing.memorize.model,
      system: prompt,
      messages: [{ role: "user", content: "Manage memory." }],
      maxTokens: config.routing.memorize.maxTokens,
    });

    const text = extractText(response.content);
    const ops = parseMemorizeResponse(text);
    return { ops, usage: response.usage };
  } catch {
    return { ops: {}, usage: ZERO_USAGE };
  }
}

function formatMemoriesWithCosts(memories: MemoryStore): string {
  if (memories.memories.length === 0) return "(no memories)";
  return memories.memories
    .map((m) => {
      if (m.context) {
        return `[${m.id}] (tokens:${m.tokenCost})\n  User: ${m.context}\n  Agent: ${m.content}`;
      }
      return `[${m.id}] ${m.type} (tokens:${m.tokenCost}) ${m.content}`;
    })
    .join("\n");
}

function parseMemorizeResponse(text: string): MemorizeOps {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return {};

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      store: Array.isArray(parsed.store) ? parsed.store : undefined,
      forget: Array.isArray(parsed.forget) ? parsed.forget : undefined,
      compress: Array.isArray(parsed.compress) ? parsed.compress : undefined,
      consolidate: parsed.consolidate ?? undefined,
      promptRewrite: typeof parsed.promptRewrite === "string"
        ? parsed.promptRewrite
        : typeof parsed.prompt_rewrite === "string"
          ? parsed.prompt_rewrite
          : undefined,
      memorizeRewrite: typeof parsed.memorizeRewrite === "string"
        ? parsed.memorizeRewrite
        : typeof parsed.memorize_rewrite === "string"
          ? parsed.memorize_rewrite
          : undefined,
      resolveRewrite: typeof parsed.resolveRewrite === "string"
        ? parsed.resolveRewrite
        : typeof parsed.resolve_rewrite === "string"
          ? parsed.resolve_rewrite
          : undefined,
    };
  } catch {
    return {};
  }
}

// ── Apply operations ────────────────────────────────────────────────

/**
 * Apply parsed memorize operations to the memory store and config.
 * Returns a human-readable summary of what was done.
 */
export function applyMemorizeOperations(
  ops: MemorizeOps,
  memories: MemoryStore,
  config: Config,
): string[] {
  const results: string[] = [];

  if (ops.store) {
    for (const m of ops.store) {
      if (m.content && m.type && typeof m.importance === "number") {
        const mem = memories.add(m.content, m.type as MemoryType, m.importance);
        results.push(`stored ${mem.type}:${mem.importance.toFixed(1)}`);
      }
    }
  }

  if (ops.forget) {
    for (const id of ops.forget) {
      memories.forget(id);
      results.push(`forgot ${id}`);
    }
  }

  if (ops.compress) {
    for (const c of ops.compress) {
      if (c.id && c.newContent) {
        memories.compress(c.id, c.newContent);
        results.push(`compressed ${c.id}`);
      }
    }
  }

  if (ops.consolidate) {
    const { sourceIds, newContent, importance } = ops.consolidate;
    if (sourceIds?.length && newContent) {
      memories.consolidate(sourceIds, newContent, importance ?? 0.5);
      results.push(`consolidated ${sourceIds.length} memories`);
    }
  }

  if (ops.promptRewrite) {
    config.rewrite("systemPrompt", ops.promptRewrite);
    results.push("rewrote systemPrompt");
  }

  if (ops.memorizeRewrite) {
    config.rewrite("memorizePrompt", ops.memorizeRewrite);
    results.push("rewrote memorizePrompt");
  }

  if (ops.resolveRewrite) {
    config.rewrite("resolvePrompt", ops.resolveRewrite);
    results.push("rewrote resolvePrompt");
  }

  return results;
}
