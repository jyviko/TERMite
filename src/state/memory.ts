import type { Memory, MemoryType } from "../types/index.js";
import { randomUUID } from "node:crypto";

export class MemoryStore {
  memories: Memory[];

  constructor(memories?: Memory[]) {
    this.memories = memories ?? [];
  }

  add(content: string, type: MemoryType, importance: number): Memory {
    const now = Date.now();
    const mem: Memory = {
      id: `mem_${randomUUID().slice(0, 8)}`,
      content,
      type,
      importance: Math.max(0, Math.min(1, importance)),
      accessCount: 0,
      createdAt: now,
      lastAccessed: now,
      energySaved: 0,
      tokenCost: this.estimateTokens(content),
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
    mem.tokenCost = this.estimateTokens(newContent);
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

    // Add consolidated memory
    const mem = this.add(newContent, "semantic", importance);
    mem.energySaved = Math.max(0, totalOldTokens - mem.tokenCost);

    return mem.energySaved;
  }

  decayEvict(threshold = 0.05): number {
    const before = this.memories.length;
    this.memories = this.memories.filter((m) => this.effectiveScore(m) >= threshold);
    return before - this.memories.length;
  }

  access(id: string): void {
    const mem = this.memories.find((m) => m.id === id);
    if (mem) {
      mem.accessCount++;
      mem.lastAccessed = Date.now();
    }
  }

  format(tokenBudget: number, maxCount?: number): string {
    const sorted = [...this.memories]
      .sort((a, b) => this.effectiveScore(b) - this.effectiveScore(a));

    const limited = maxCount ? sorted.slice(0, maxCount) : sorted;

    const lines: string[] = [];
    let totalTokens = 0;

    for (const m of limited) {
      if (totalTokens + m.tokenCost > tokenBudget) break;
      lines.push(`[${m.type}] (${m.importance.toFixed(1)}) ${m.content}`);
      totalTokens += m.tokenCost;
    }

    return lines.length > 0 ? lines.join("\n") : "(no memories yet)";
  }

  effectiveScore(m: Memory): number {
    const ageHours = (Date.now() - m.createdAt) / (1000 * 60 * 60);
    const decay = Math.pow(0.5, ageHours / 24);
    const accessBoost = Math.log(1 + m.accessCount) * 0.1;
    return m.importance * decay + accessBoost;
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
    return new MemoryStore(data);
  }
}
