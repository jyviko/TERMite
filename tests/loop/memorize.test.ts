import { describe, it, expect } from "vitest";
import { MemoryStore } from "../../src/state/memory.js";
import { Config } from "../../src/state/config.js";
import { parseMemorizeResponse, applyMemorizeOperations, type MemorizeOps } from "../../src/loop/memorize.js";

// ── parseMemorizeResponse ───────────────────────────────────────────

describe("parseMemorizeResponse", () => {
  it("parses forget operations", () => {
    const ops = parseMemorizeResponse('{"forget":["mem_abc123","mem_def456"]}');
    expect(ops.forget).toEqual(["mem_abc123", "mem_def456"]);
  });

  it("parses compress operations", () => {
    const ops = parseMemorizeResponse('{"compress":[{"id":"mem_abc","newContent":"shorter version"}]}');
    expect(ops.compress).toHaveLength(1);
    expect(ops.compress![0]!.newContent).toBe("shorter version");
  });

  it("parses consolidate operations", () => {
    const ops = parseMemorizeResponse('{"consolidate":{"sourceIds":["mem_a","mem_b"],"newContent":"combined","importance":0.9}}');
    expect(ops.consolidate).toBeDefined();
    expect(ops.consolidate!.sourceIds).toEqual(["mem_a", "mem_b"]);
  });

  it("parses promptRewrite field", () => {
    const ops = parseMemorizeResponse('{"promptRewrite":"Be efficient. Use tools."}');
    expect(ops.promptRewrite).toBe("Be efficient. Use tools.");
  });

  it("handles snake_case prompt_rewrite from LLM", () => {
    const ops = parseMemorizeResponse('{"prompt_rewrite":"Be efficient."}');
    expect(ops.promptRewrite).toBe("Be efficient.");
  });

  it("parses memorizeRewrite and resolveRewrite", () => {
    const ops = parseMemorizeResponse('{"memorizeRewrite":"new mem prompt","resolveRewrite":"new resolve prompt"}');
    expect(ops.memorizeRewrite).toBe("new mem prompt");
    expect(ops.resolveRewrite).toBe("new resolve prompt");
  });

  it("returns empty ops for invalid JSON", () => {
    expect(parseMemorizeResponse("not json at all")).toEqual({});
  });

  it("returns empty ops for empty string", () => {
    expect(parseMemorizeResponse("")).toEqual({});
  });

  it("extracts JSON from surrounding text", () => {
    const ops = parseMemorizeResponse('Here is my response:\n{"forget":["mem_x"]}\nDone.');
    expect(ops.forget).toEqual(["mem_x"]);
  });

  it("parses store operations", () => {
    const ops = parseMemorizeResponse('{"store":[{"content":"always run check first","type":"procedural","importance":0.8}]}');
    expect(ops.store).toHaveLength(1);
    expect(ops.store![0]!.content).toBe("always run check first");
    expect(ops.store![0]!.type).toBe("procedural");
    expect(ops.store![0]!.importance).toBe(0.8);
  });
});

// ── applyMemorizeOperations ─────────────────────────────────────────

describe("applyMemorizeOperations", () => {
  it("forgets memories", () => {
    const memories = new MemoryStore();
    const mem = memories.add("old fact", "semantic", 0.5);
    const ops: MemorizeOps = { forget: [mem.id] };
    const config = new Config();

    const results = applyMemorizeOperations(ops, memories, config);

    expect(results).toHaveLength(1);
    expect(results[0]).toContain("forgot");
    expect(memories.memories).toHaveLength(0);
  });

  it("compresses memories", () => {
    const memories = new MemoryStore();
    const mem = memories.add("very long verbose description of a fact", "semantic", 0.7, "Cycle 5");
    const ops: MemorizeOps = { compress: [{ id: mem.id, newContent: "short fact" }] };
    const config = new Config();

    applyMemorizeOperations(ops, memories, config);

    expect(memories.memories[0]!.content).toBe("short fact");
  });

  it("consolidates memories", () => {
    const memories = new MemoryStore();
    const m1 = memories.add("fact A", "semantic", 0.5, "Cycle 1");
    const m2 = memories.add("fact B", "semantic", 0.6, "Cycle 2");
    const ops: MemorizeOps = {
      consolidate: { sourceIds: [m1.id, m2.id], newContent: "fact A+B", importance: 0.8 },
    };
    const config = new Config();

    applyMemorizeOperations(ops, memories, config);

    expect(memories.memories).toHaveLength(1);
    expect(memories.memories[0]!.content).toBe("fact A+B");
    expect(memories.memories[0]!.importance).toBe(0.8);
  });

  it("applies prompt rewrite", () => {
    const memories = new MemoryStore();
    const config = new Config();
    const original = config.systemPrompt;
    const ops: MemorizeOps = { promptRewrite: "New optimized prompt." };

    const results = applyMemorizeOperations(ops, memories, config);

    expect(results).toContain("rewrote systemPrompt");
    expect(config.systemPrompt).toBe("New optimized prompt.");
    expect(config.systemPrompt).not.toBe(original);
    expect(config.version).toBe(1);
  });

  it("stores new memories", () => {
    const memories = new MemoryStore();
    const config = new Config();
    const ops: MemorizeOps = {
      store: [{ content: "always run check first", type: "procedural", importance: 0.8 }],
    };

    const results = applyMemorizeOperations(ops, memories, config);

    expect(results).toHaveLength(1);
    expect(results[0]).toContain("stored");
    expect(memories.memories).toHaveLength(1);
    expect(memories.memories[0]!.content).toBe("always run check first");
    expect(memories.memories[0]!.type).toBe("procedural");
    expect(memories.memories[0]!.importance).toBe(0.8);
  });

  it("store ignores entries with missing fields", () => {
    const memories = new MemoryStore();
    const config = new Config();
    const ops: MemorizeOps = {
      store: [{ content: "", type: "semantic", importance: 0.5 }],
    };

    const results = applyMemorizeOperations(ops, memories, config);

    expect(results).toHaveLength(0);
    expect(memories.memories).toHaveLength(0);
  });

  it("handles empty ops gracefully", () => {
    const ops: MemorizeOps = {};
    const memories = new MemoryStore();
    const config = new Config();

    const results = applyMemorizeOperations(ops, memories, config);

    expect(results).toHaveLength(0);
  });
});
