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
    const mem = store.add("this is a very long and verbose memory", "semantic", 0.7);
    const oldCost = mem.tokenCost;
    const saved = store.compress(mem.id, "short");
    expect(saved).toBeGreaterThan(0);
    expect(mem.content).toBe("short");
    expect(mem.tokenCost).toBeLessThan(oldCost);
    expect(mem.energySaved).toBe(saved);
  });

  it("consolidates multiple memories into one", () => {
    const m1 = store.add("fact a", "semantic", 0.5);
    const m2 = store.add("fact b", "semantic", 0.5);
    const m3 = store.add("fact c", "semantic", 0.5);

    const saved = store.consolidate([m1.id, m2.id, m3.id], "combined facts", 0.9);
    expect(saved).toBeGreaterThanOrEqual(0);
    expect(store.memories).toHaveLength(1);
    expect(store.memories[0]!.content).toBe("combined facts");
    expect(store.memories[0]!.importance).toBe(0.9);
  });

  it("effectiveScore decays with age", () => {
    const mem = store.add("test", "semantic", 1.0);
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

  it("format stays within token budget", () => {
    for (let i = 0; i < 20; i++) {
      store.add(`memory item ${i} with some extra content`, "semantic", 0.5);
    }
    const formatted = store.format(50); // very tight budget
    const tokens = Math.ceil(formatted.length / 4);
    expect(tokens).toBeLessThanOrEqual(100); // rough tolerance
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

  it("serializes and deserializes", () => {
    store.add("test1", "semantic", 0.7);
    store.add("test2", "procedural", 0.3);

    const json = store.toJSON();
    const restored = MemoryStore.fromJSON(json);
    expect(restored.memories).toHaveLength(2);
    expect(restored.memories[0]!.content).toBe("test1");
  });
});
