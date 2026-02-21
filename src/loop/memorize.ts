import type { MemoryType } from "../types/index.js";
import type { Genome } from "../state/genome.js";
import type { MemoryStore } from "../state/memory.js";

// ── Epigenetic operations (within-lifetime memories) ────────────────

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

// ── Phylogenetic operations (genome mutations) ──────────────────────

interface MutateOp {
  target: string;
  newPrompt: string;
}

interface PhylogeneticOps {
  mutate?: MutateOp[];
}

// ── Parsed result ───────────────────────────────────────────────────

export interface ParsedMemorizeInput {
  epigenetic: EpigeneticOps;
  phylogenetic: PhylogeneticOps;
  hasWork: boolean;
}

/**
 * Parse structured memorize input from tool_use.
 * Accepts the structured schema (epigenetic/phylogenetic) or
 * legacy format (flat JSON in `input` string field) for backward compat.
 */
export function parseMemorizeInput(raw: Record<string, unknown>): ParsedMemorizeInput {
  const epigenetic: EpigeneticOps = {};
  const phylogenetic: PhylogeneticOps = {};

  // Structured input — epigenetic/phylogenetic fields
  if (raw.epigenetic || raw.phylogenetic) {
    const epi = raw.epigenetic as EpigeneticOps | undefined;
    if (epi) {
      if (epi.store) epigenetic.store = epi.store;
      if (epi.forget) epigenetic.forget = epi.forget;
      if (epi.compress) epigenetic.compress = epi.compress;
      if (epi.consolidate) epigenetic.consolidate = epi.consolidate;
    }
    const phylo = raw.phylogenetic as PhylogeneticOps | undefined;
    if (phylo?.mutate) {
      phylogenetic.mutate = phylo.mutate;
    }
  } else if (raw.input != null) {
    // Legacy: JSON or plain text in `input` string field
    const inputStr = String(raw.input).trim();
    if (!inputStr) return { epigenetic, phylogenetic, hasWork: false };

    try {
      const jsonMatch = inputStr.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.store) epigenetic.store = parsed.store;
        if (parsed.forget) epigenetic.forget = parsed.forget;
        if (parsed.compress) epigenetic.compress = parsed.compress;
        if (parsed.consolidate) epigenetic.consolidate = parsed.consolidate;
        if (parsed.mutate) {
          phylogenetic.mutate = Array.isArray(parsed.mutate) ? parsed.mutate : [parsed.mutate];
        }
      } else {
        // Plain text → semantic memory
        epigenetic.store = [{ content: inputStr, type: "semantic", importance: 0.5 }];
      }
    } catch {
      // JSON parse failed → plain text
      epigenetic.store = [{ content: inputStr, type: "semantic", importance: 0.5 }];
    }
  }

  const hasWork =
    !!epigenetic.store?.length ||
    !!epigenetic.forget?.length ||
    !!epigenetic.compress?.length ||
    !!epigenetic.consolidate ||
    !!phylogenetic.mutate?.length;

  return { epigenetic, phylogenetic, hasWork };
}

/**
 * Apply parsed memorize operations.
 * Returns a human-readable summary of what was done.
 */
export function applyMemorizeOperations(
  ops: ParsedMemorizeInput,
  memories: MemoryStore,
  genome: Genome,
): string[] {
  const results: string[] = [];

  // ── Epigenetic: memory operations ──
  const epi = ops.epigenetic;

  if (epi.store) {
    for (const m of epi.store) {
      if (m.content && m.type && typeof m.importance === "number") {
        const mem = memories.add(m.content, m.type as MemoryType, m.importance);
        results.push(`stored ${mem.type}:${mem.importance.toFixed(1)}`);
      }
    }
  }

  if (epi.forget) {
    for (const id of epi.forget) {
      memories.forget(id);
      results.push(`forgot ${id}`);
    }
  }

  if (epi.compress) {
    for (const c of epi.compress) {
      if (c.id && c.newContent) {
        memories.compress(c.id, c.newContent);
        results.push(`compressed ${c.id}`);
      }
    }
  }

  if (epi.consolidate) {
    const { sourceIds, newContent, importance } = epi.consolidate;
    if (sourceIds?.length && newContent) {
      memories.consolidate(sourceIds, newContent, importance ?? 0.5);
      results.push(`consolidated ${sourceIds.length} memories`);
    }
  }

  // ── Phylogenetic: genome mutations ──
  if (ops.phylogenetic.mutate) {
    for (const m of ops.phylogenetic.mutate) {
      if (m.target && m.newPrompt?.trim()) {
        genome.mutate(m.target, m.newPrompt);
        results.push(`mutated ${m.target}`);
      }
    }
  }

  return results;
}
