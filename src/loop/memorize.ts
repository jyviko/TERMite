import type { MemoryType } from "../types/index.js";
import type { Genome } from "../state/genome.js";
import type { MemoryStore } from "../state/memory.js";

interface MutateOp {
  target: string;
  newPrompt: string;
}

export interface MemorizeOperations {
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

/**
 * Parse organism's memorize input into structured operations.
 * Accepts JSON (may be wrapped in markdown) or plain text fallback.
 * Plain text is treated as a simple store with type "semantic" and importance 0.5.
 */
export function parseMemorizeInput(input: string): MemorizeOperations {
  try {
    const jsonMatch = input.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      // Plain text fallback — store as semantic memory
      const text = input.trim();
      if (!text) return {};
      return { store: [{ content: text, type: "semantic", importance: 0.5 }] };
    }
    return JSON.parse(jsonMatch[0]);
  } catch {
    // JSON parse failed — treat entire input as plain text store
    const text = input.trim();
    if (!text) return {};
    return { store: [{ content: text, type: "semantic", importance: 0.5 }] };
  }
}

/**
 * Apply memory operations: store, forget, compress, consolidate, mutate.
 * Returns a human-readable summary of what was done.
 */
export function applyMemorizeOperations(
  ops: MemorizeOperations,
  memories: MemoryStore,
  genome: Genome,
): string[] {
  const results: string[] = [];

  // Store new memories
  if (ops.store) {
    for (const m of ops.store) {
      if (m.content && m.type && typeof m.importance === "number") {
        const mem = memories.add(m.content, m.type as MemoryType, m.importance);
        results.push(`stored ${mem.type}:${mem.importance.toFixed(1)}`);
      }
    }
  }

  // Forget memories by ID
  if (ops.forget) {
    for (const id of ops.forget) {
      memories.forget(id);
      results.push(`forgot ${id}`);
    }
  }

  // Compress memories
  if (ops.compress) {
    for (const c of ops.compress) {
      if (c.id && c.newContent) {
        memories.compress(c.id, c.newContent);
        results.push(`compressed ${c.id}`);
      }
    }
  }

  // Consolidate memories
  if (ops.consolidate) {
    const { sourceIds, newContent, importance } = ops.consolidate;
    if (sourceIds?.length && newContent) {
      memories.consolidate(sourceIds, newContent, importance ?? 0.5);
      results.push(`consolidated ${sourceIds.length} memories`);
    }
  }

  // Self-mutation — accepts an array or a single object for backward compat
  if (ops.mutate) {
    const mutations = Array.isArray(ops.mutate) ? ops.mutate : [ops.mutate];
    for (const m of mutations) {
      if (m.target && m.newPrompt?.trim()) {
        genome.mutate(m.target, m.newPrompt);
        results.push(`mutated ${m.target}`);
      }
    }
  }

  return results;
}
