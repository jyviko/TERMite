import { describe, it, expect, beforeEach } from "vitest";
import { MemoryStore } from "../../src/state/memory.js";

describe("MemoryStore", () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore();
  });

  it("adds memories with generated IDs", () => {
    const mem = store.add("learned something", "semantic", 0.8);
    expect(mem.id).toMatch(/^mem_/);
    expect(mem.content).toBe("learned something");
    expect(mem.importance).toBe(0.8);
    expect(store.memories).toHaveLength(1);
  });

  it("adds memories with context (user/agent pairs)", () => {
    const mem = store.add("ran shell, found tools", "episodic", 0.7, "Cycle 1. Goal: explore");
    expect(mem.context).toBe("Cycle 1. Goal: explore");
    expect(mem.content).toBe("ran shell, found tools");
    expect(mem.tokenCost).toBeGreaterThan(0);
  });

  it("clamps importance to [0, 1]", () => {
    const m1 = store.add("a", "semantic", -0.5);
    const m2 = store.add("b", "semantic", 1.5);
    expect(m1.importance).toBe(0);
    expect(m2.importance).toBe(1);
  });

  it("forgets memories by ID", () => {
    const mem = store.add("test", "episodic", 0.5);
    expect(store.forget(mem.id)).toBe(true);
    expect(store.memories).toHaveLength(0);
    expect(store.forget("nonexistent")).toBe(false);
  });

  it("compresses a memory and tracks savings", () => {
    const mem = store.add("this is a very long and verbose memory", "semantic", 0.7, "Cycle 5");
    const oldCost = mem.tokenCost;
    const saved = store.compress(mem.id, "short");
    expect(saved).toBeGreaterThan(0);
    expect(mem.content).toBe("short");
    expect(mem.tokenCost).toBeLessThan(oldCost);
    expect(mem.energySaved).toBe(saved);
  });

  it("consolidates multiple memories into one", () => {
    const m1 = store.add("fact a", "semantic", 0.5, "Cycle 1");
    const m2 = store.add("fact b", "semantic", 0.5, "Cycle 2");
    const m3 = store.add("fact c", "semantic", 0.5, "Cycle 3");

    const saved = store.consolidate([m1.id, m2.id, m3.id], "combined facts", 0.9);
    expect(saved).toBeGreaterThanOrEqual(0);
    expect(store.memories).toHaveLength(1);
    expect(store.memories[0]!.content).toBe("combined facts");
    expect(store.memories[0]!.importance).toBe(0.9);
    expect(store.memories[0]!.context).toContain("Cycle 1");
  });

  it("effectiveScore decays with age for episodic memories", () => {
    // Only episodic memories decay — semantic/procedural persist at full weight
    const mem = store.add("test", "episodic", 1.0);
    const scoreNow = store.effectiveScore(mem);

    // Simulate age by backdating
    mem.createdAt = Date.now() - 48 * 60 * 60 * 1000; // 48 hours ago
    const scoreLater = store.effectiveScore(mem);
    expect(scoreLater).toBeLessThan(scoreNow);
  });

  it("access boosts effective score", () => {
    const mem = store.add("test", "semantic", 0.5);
    const scoreBefore = store.effectiveScore(mem);
    store.access(mem.id);
    const scoreAfter = store.effectiveScore(mem);
    expect(scoreAfter).toBeGreaterThan(scoreBefore);
  });

  it("formatAsMessages returns user/agent pairs in chronological order", () => {
    store.add("actions from cycle 1", "episodic", 0.7, "Cycle 1. Goal: explore");
    store.add("actions from cycle 2", "episodic", 0.7, "Cycle 2. Goal: acquire");

    const messages = store.formatAsMessages(5000);
    expect(messages).toHaveLength(4); // 2 pairs
    expect(messages[0]!.role).toBe("user");
    expect(messages[0]!.content).toBe("Cycle 1. Goal: explore");
    expect(messages[1]!.role).toBe("assistant");
    expect(messages[1]!.content).toBe("actions from cycle 1");
    expect(messages[2]!.role).toBe("user");
    expect(messages[2]!.content).toBe("Cycle 2. Goal: acquire");
    expect(messages[3]!.role).toBe("assistant");
    expect(messages[3]!.content).toBe("actions from cycle 2");
  });

  it("formatAsMessages respects token budget", () => {
    for (let i = 0; i < 20; i++) {
      store.add(`actions ${i} with lots of extra content padding here`, "episodic", 0.5, `Cycle ${i}`);
    }
    const messages = store.formatAsMessages(100); // tight budget
    // Should have fewer than all 20 pairs but still some content
    expect(messages.length).toBeLessThan(40);
    expect(messages.length).toBeGreaterThan(0);
    // Messages should be in user/assistant pairs
    expect(messages.length % 2).toBe(0);
    // Selected pairs should be chronologically ordered
    const userMessages = messages.filter((_, i) => i % 2 === 0);
    for (let i = 1; i < userMessages.length; i++) {
      const prevCycle = parseInt(userMessages[i - 1]!.content.replace("Cycle ", ""));
      const currCycle = parseInt(userMessages[i]!.content.replace("Cycle ", ""));
      expect(currCycle).toBeGreaterThan(prevCycle);
    }
  });

  it("format shows pairs for memorize management view", () => {
    store.add("ran check, got FAIL", "episodic", 0.7, "Cycle 5. Goal: explore");
    const formatted = store.format(5000);
    expect(formatted).toContain("User: Cycle 5");
    expect(formatted).toContain("Agent: ran check");
    expect(formatted).toContain("mem_");
  });

  it("format stays within token budget", () => {
    for (let i = 0; i < 20; i++) {
      store.add(`memory item ${i} with some extra content`, "semantic", 0.5);
    }
    const formatted = store.format(50); // very tight budget
    const tokens = Math.ceil(formatted.length / 4);
    expect(tokens).toBeLessThanOrEqual(120); // rough tolerance
  });

  it("decayEvict removes low-score entries", () => {
    const old = store.add("old memory", "episodic", 0.01);
    old.createdAt = Date.now() - 30 * 24 * 60 * 60 * 1000; // 30 days ago

    store.add("fresh memory", "semantic", 0.9);

    const evicted = store.decayEvict();
    expect(evicted).toBe(1);
    expect(store.memories).toHaveLength(1);
    expect(store.memories[0]!.content).toBe("fresh memory");
  });

  it("formatMetadataOnly returns (no memories) when empty", () => {
    expect(store.formatMetadataOnly()).toBe("(no memories)");
  });

  it("formatMetadataOnly shows ID, type, importance, tokens, preview", () => {
    store.add("a short fact about tools", "semantic", 0.7);
    const output = store.formatMetadataOnly();
    expect(output).toMatch(/\[mem_\w+\]/);
    expect(output).toContain("semantic");
    expect(output).toContain("imp:0.7");
    expect(output).toContain("tokens:");
    expect(output).toContain("a short fact about tools");
  });

  it("formatMetadataOnly flattens newlines in preview", () => {
    store.add("line one\nline two\nline three", "episodic", 0.5);
    const output = store.formatMetadataOnly();
    expect(output).not.toContain("\nline");
    expect(output).toContain("line one line two");
  });

  it("formatMetadataOnly marks budget-excluded memories", () => {
    // Add memories with varying importance
    store.add("high value fact", "procedural", 0.9, "Cycle 1");
    store.add("low value noise", "episodic", 0.1, "Cycle 2");

    // formatAsMessages with tiny budget — only one memory fits (~6 tokens each)
    store.formatAsMessages(8);

    const output = store.formatMetadataOnly();
    const lines = output.split("\n");
    // One line should have [not in context], the other should not
    const inContext = lines.filter((l) => !l.includes("[not in context]"));
    const excluded = lines.filter((l) => l.includes("[not in context]"));
    expect(inContext.length).toBeGreaterThanOrEqual(1);
    expect(excluded.length).toBeGreaterThanOrEqual(1);
  });

  it("serializes and deserializes with context", () => {
    store.add("test1", "semantic", 0.7, "Cycle 1");
    store.add("test2", "procedural", 0.3);

    const json = store.toJSON();
    const restored = MemoryStore.fromJSON(json);
    expect(restored.memories).toHaveLength(2);
    expect(restored.memories[0]!.content).toBe("test1");
    expect(restored.memories[0]!.context).toBe("Cycle 1");
    expect(restored.memories[1]!.context).toBe(""); // backward compat
  });
});
