import type { Memory, MemoryType } from "../types/index.js";
import { randomUUID } from "node:crypto";

export interface MessagePair {
  role: "user" | "assistant";
  content: string;
}

export class MemoryStore {
  memories: Memory[];

  /** IDs of memories injected into the conversation by the last formatAsMessages call. */
  private injectedIds = new Set<string>();

  constructor(memories?: Memory[]) {
    this.memories = memories ?? [];
  }

  add(content: string, type: MemoryType, importance: number, context = ""): Memory {
    const now = Date.now();
    const mem: Memory = {
      id: `mem_${randomUUID().slice(0, 8)}`,
      context,
      content,
      type,
      importance: Math.max(0, Math.min(1, importance)),
      accessCount: 0,
      createdAt: now,
      lastAccessed: now,
      energySaved: 0,
      tokenCost: this.estimateTokens(context + content),
    };
    this.memories.push(mem);
    return mem;
  }

  forget(id: string): boolean {
    const idx = this.memories.findIndex((m) => m.id === id);
    if (idx === -1) return false;
    this.memories.splice(idx, 1);
    return true;
  }

  compress(id: string, newContent: string): number {
    const mem = this.memories.find((m) => m.id === id);
    if (!mem) return 0;
    const oldCost = mem.tokenCost;
    mem.content = newContent;
    mem.tokenCost = this.estimateTokens(mem.context + newContent);
    const saved = oldCost - mem.tokenCost;
    mem.energySaved += Math.max(0, saved);
    return Math.max(0, saved);
  }

  consolidate(ids: string[], newContent: string, importance: number): number {
    const sources = this.memories.filter((m) => ids.includes(m.id));
    if (sources.length === 0) return 0;
    const totalOldTokens = sources.reduce((s, m) => s + m.tokenCost, 0);

    // Remove source memories
    this.memories = this.memories.filter((m) => !ids.includes(m.id));

    // Consolidated memory — merge contexts
    const mergedContext = sources
      .filter((m) => m.context)
      .map((m) => m.context)
      .join(" → ");
    const mem = this.add(newContent, "semantic", importance, mergedContext);
    mem.energySaved = Math.max(0, totalOldTokens - mem.tokenCost);

    return mem.energySaved;
  }

  decayEvict(threshold = 0.05): number {
    const before = this.memories.length;
    this.memories = this.memories.filter((m) => {
      // Never auto-evict procedural memories above minimum importance
      if (m.type === "procedural" && m.importance >= 0.3) return true;
      return this.effectiveScore(m) >= threshold;
    });
    return before - this.memories.length;
  }

  access(id: string): void {
    const mem = this.memories.find((m) => m.id === id);
    if (mem) {
      mem.accessCount++;
      mem.lastAccessed = Date.now();
    }
  }

  /**
   * Format memories as user/assistant message pairs for conversation injection.
   * Score-ranked selection, chronological output. This IS the agent's persistent history.
   */
  formatAsMessages(tokenBudget: number): MessagePair[] {
    // Select highest-scored memories that fit budget (not most recent)
    const ranked = [...this.memories]
      .sort((a, b) => this.effectiveScore(b) - this.effectiveScore(a));

    const selected: Memory[] = [];
    this.injectedIds = new Set();
    let totalTokens = 0;
    for (const m of ranked) {
      if (totalTokens + m.tokenCost > tokenBudget) continue;  // skip if too large, try next
      selected.push(m);
      this.injectedIds.add(m.id);
      totalTokens += m.tokenCost;
      m.accessCount++;  // track access for scoring boost
      m.lastAccessed = Date.now();
    }

    // Sort selected by creation time for conversation coherence
    selected.sort((a, b) => a.createdAt - b.createdAt);

    const messages: MessagePair[] = [];
    for (const m of selected) {
      messages.push({ role: "user", content: m.context || `[${m.type}]` });
      messages.push({ role: "assistant", content: m.content });
    }
    return messages;
  }

  /**
   * Format memories as text for the memorize prompt (management view).
   * Shows IDs, types, costs so the LLM can decide what to compress/forget.
   */
  format(tokenBudget: number, maxCount?: number): string {
    const sorted = [...this.memories]
      .sort((a, b) => this.effectiveScore(b) - this.effectiveScore(a));

    const limited = maxCount ? sorted.slice(0, maxCount) : sorted;

    const lines: string[] = [];
    let totalTokens = 0;

    for (const m of limited) {
      if (totalTokens + m.tokenCost > tokenBudget) break;
      if (m.context) {
        lines.push(`[${m.id}] ${m.type} (imp:${m.importance.toFixed(1)}, tokens:${m.tokenCost})`);
        lines.push(`  User: ${m.context}`);
        lines.push(`  Agent: ${m.content}`);
      } else {
        lines.push(`[${m.id}] ${m.type} (imp:${m.importance.toFixed(1)}, tokens:${m.tokenCost}) ${m.content}`);
      }
      totalTokens += m.tokenCost;
    }

    return lines.length > 0 ? lines.join("\n") : "(no memories yet)";
  }

  /**
   * Slim inventory for the memorize post-turn: IDs, types, importance, token costs, preview.
   * Full content is already in the conversation as user/assistant pairs.
   */
  formatMetadataOnly(): string {
    if (this.memories.length === 0) return "(no memories)";
    return this.memories
      .map((m) => {
        const preview = m.content.slice(0, 60).replace(/\n/g, " ");
        const tag = this.injectedIds.has(m.id) ? "" : " [not in context]";
        return `[${m.id}] ${m.type} imp:${m.importance.toFixed(1)} tokens:${m.tokenCost}${tag} "${preview}..."`;
      })
      .join("\n");
  }

  effectiveScore(m: Memory): number {
    const ageHours = (Date.now() - m.createdAt) / (1000 * 60 * 60);
    // Only episodic memories decay — procedural/semantic knowledge persists
    const decay = m.type === "episodic"
      ? Math.pow(0.5, ageHours / 24)
      : 1.0;
    const typeWeight = m.type === "procedural" ? 1.0 : m.type === "semantic" ? 0.85 : 0.5;
    const accessBoost = Math.log(1 + m.accessCount) * 0.15;
    return m.importance * typeWeight * decay + accessBoost;
  }

  get totalTokenCost(): number {
    return this.memories.reduce((sum, m) => sum + m.tokenCost, 0);
  }

  private estimateTokens(content: string): number {
    // Rough estimate: ~4 chars per token
    return Math.ceil(content.length / 4);
  }

  toJSON(): Memory[] {
    return this.memories.map((m) => ({ ...m }));
  }

  static fromJSON(data: Memory[]): MemoryStore {
    return new MemoryStore(data.map((m) => ({ ...m, context: m.context ?? "" })));
  }
}
