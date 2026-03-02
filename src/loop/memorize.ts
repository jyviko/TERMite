import type { MemoryType } from "../types/index.js";
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
  idleSeconds?: number;
}

export function parseMemorizeResponse(text: string): MemorizeOps {
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
      idleSeconds: typeof parsed.idleSeconds === "number"
        ? Math.max(0, Math.min(60, Math.floor(parsed.idleSeconds)))
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
