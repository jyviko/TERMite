import type { MemoryType } from "../types/index.js";
import type { Config } from "../state/config.js";
import type { MemoryStore } from "../state/memory.js";

// ── Session operations (cycle-scoped memories) ─────────────────────

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

interface EpigeneticOps {
  store?: StoreOp[];
  forget?: string[];
  compress?: CompressOp[];
  consolidate?: ConsolidateOp;
}

// ── Persistent operations (prompt rewrites) ─────────────────────────

interface RewriteOp {
  target: string;
  newPrompt: string;
}

interface PersistentOps {
  rewrite?: RewriteOp[];
}

// ── Parsed result ───────────────────────────────────────────────────

export interface ParsedMemorizeInput {
  session: EpigeneticOps;
  persistent: PersistentOps;
  hasWork: boolean;
}

/**
 * Parse structured memorize input from tool_use.
 * Accepts the structured schema (session/persistent) or
 * flat JSON in `input` string field.
 */
export function parseMemorizeInput(raw: Record<string, unknown>): ParsedMemorizeInput {
  const session: EpigeneticOps = {};
  const persistent: PersistentOps = {};

  // Structured input — session/persistent fields
  if (raw.session || raw.persistent) {
    const s = raw.session as EpigeneticOps | undefined;
    if (s) {
      if (s.store) session.store = s.store;
      if (s.forget) session.forget = s.forget;
      if (s.compress) session.compress = s.compress;
      if (s.consolidate) session.consolidate = s.consolidate;
    }
    const p = raw.persistent as PersistentOps | undefined;
    if (p?.rewrite) {
      persistent.rewrite = p.rewrite;
    }
  } else if (raw.input != null) {
    const inputStr = String(raw.input).trim();
    if (!inputStr) return { session, persistent, hasWork: false };

    try {
      const jsonMatch = inputStr.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.store) session.store = parsed.store;
        if (parsed.forget) session.forget = parsed.forget;
        if (parsed.compress) session.compress = parsed.compress;
        if (parsed.consolidate) session.consolidate = parsed.consolidate;
        if (parsed.rewrite) {
          persistent.rewrite = Array.isArray(parsed.rewrite) ? parsed.rewrite : [parsed.rewrite];
        }
      } else {
        session.store = [{ content: inputStr, type: "semantic", importance: 0.5 }];
      }
    } catch {
      session.store = [{ content: inputStr, type: "semantic", importance: 0.5 }];
    }
  }

  const hasWork =
    !!session.store?.length ||
    !!session.forget?.length ||
    !!session.compress?.length ||
    !!session.consolidate ||
    !!persistent.rewrite?.length;

  return { session, persistent, hasWork };
}

/**
 * Apply parsed memorize operations.
 * Returns a human-readable summary of what was done.
 */
export function applyMemorizeOperations(
  ops: ParsedMemorizeInput,
  memories: MemoryStore,
  config: Config,
): string[] {
  const results: string[] = [];

  // ── Session: memory operations ──
  const s = ops.session;

  if (s.store) {
    for (const m of s.store) {
      if (m.content && m.type && typeof m.importance === "number") {
        const mem = memories.add(m.content, m.type as MemoryType, m.importance);
        results.push(`stored ${mem.type}:${mem.importance.toFixed(1)}`);
      }
    }
  }

  if (s.forget) {
    for (const id of s.forget) {
      memories.forget(id);
      results.push(`forgot ${id}`);
    }
  }

  if (s.compress) {
    for (const c of s.compress) {
      if (c.id && c.newContent) {
        memories.compress(c.id, c.newContent);
        results.push(`compressed ${c.id}`);
      }
    }
  }

  if (s.consolidate) {
    const { sourceIds, newContent, importance } = s.consolidate;
    if (sourceIds?.length && newContent) {
      memories.consolidate(sourceIds, newContent, importance ?? 0.5);
      results.push(`consolidated ${sourceIds.length} memories`);
    }
  }

  // ── Persistent: prompt rewrites ──
  if (ops.persistent.rewrite) {
    for (const r of ops.persistent.rewrite) {
      if (r.target && r.newPrompt?.trim()) {
        config.mutate(r.target, r.newPrompt);
        results.push(`rewrote ${r.target}`);
      }
    }
  }

  return results;
}
