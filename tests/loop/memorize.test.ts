import { describe, it, expect } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { LLM, type LLMResponse, type ChatParams } from "../../src/llm/index.js";
import { MemoryStore } from "../../src/state/memory.js";
import { Config } from "../../src/state/config.js";
import { runMemorizePhase, applyMemorizeOperations, type MemorizeOps } from "../../src/loop/memorize.js";

// ── Mock LLM ────────────────────────────────────────────────────────

class MockLLM extends LLM {
  response = "{}";
  callCount = 0;
  shouldFail = false;

  constructor() {
    super({});
  }

  async chat(_params: ChatParams): Promise<LLMResponse> {
    this.callCount++;
    if (this.shouldFail) throw new Error("LLM unavailable");
    return {
      content: [{ type: "text", text: this.response, citations: null }] as Anthropic.ContentBlock[],
      stopReason: "end_turn",
      usage: { input: 80, output: 30, cacheCreation: 0, cacheRead: 0 },
    };
  }
}

// ── runMemorizePhase ────────────────────────────────────────────────

describe("runMemorizePhase", () => {
  it("calls LLM and parses store operations", async () => {
    const llm = new MockLLM();
    llm.response = '{"store":[{"content":"test discovery","type":"semantic","importance":0.8}]}';
    const config = new Config();
    const memories = new MemoryStore();

    const result = await runMemorizePhase(llm, config, memories, "learned something", 3000, 2500, 2000);

    expect(llm.callCount).toBe(1);
    expect(result.ops.store).toHaveLength(1);
    expect(result.ops.store![0]!.content).toBe("test discovery");
    expect(result.usage.output).toBe(30);
  });

  it("parses forget operations", async () => {
    const llm = new MockLLM();
    llm.response = '{"forget":["mem_abc123","mem_def456"]}';
    const config = new Config();
    const memories = new MemoryStore();

    const result = await runMemorizePhase(llm, config, memories, "cleanup", 2000, 2000, 2000);

    expect(result.ops.forget).toEqual(["mem_abc123", "mem_def456"]);
  });

  it("parses compress operations", async () => {
    const llm = new MockLLM();
    llm.response = '{"compress":[{"id":"mem_abc","newContent":"shorter version"}]}';
    const config = new Config();
    const memories = new MemoryStore();

    const result = await runMemorizePhase(llm, config, memories, "compress", 2000, 2000, 2000);

    expect(result.ops.compress).toHaveLength(1);
    expect(result.ops.compress![0]!.newContent).toBe("shorter version");
  });

  it("parses consolidate operations", async () => {
    const llm = new MockLLM();
    llm.response = '{"consolidate":{"sourceIds":["mem_a","mem_b"],"newContent":"combined","importance":0.9}}';
    const config = new Config();
    const memories = new MemoryStore();

    const result = await runMemorizePhase(llm, config, memories, "consolidate", 2000, 2000, 2000);

    expect(result.ops.consolidate).toBeDefined();
    expect(result.ops.consolidate!.sourceIds).toEqual(["mem_a", "mem_b"]);
  });

  it("parses promptRewrite field", async () => {
    const llm = new MockLLM();
    llm.response = '{"promptRewrite":"Be efficient. Use tools."}';
    const config = new Config();
    const memories = new MemoryStore();

    const result = await runMemorizePhase(llm, config, memories, "rewrite", 2000, 2000, 2000);

    expect(result.ops.promptRewrite).toBe("Be efficient. Use tools.");
  });

  it("handles snake_case prompt_rewrite from LLM", async () => {
    const llm = new MockLLM();
    llm.response = '{"prompt_rewrite":"Be efficient."}';
    const config = new Config();
    const memories = new MemoryStore();

    const result = await runMemorizePhase(llm, config, memories, "rewrite", 2000, 2000, 2000);

    expect(result.ops.promptRewrite).toBe("Be efficient.");
  });

  it("returns empty ops on LLM failure", async () => {
    const llm = new MockLLM();
    llm.shouldFail = true;
    const config = new Config();
    const memories = new MemoryStore();

    const result = await runMemorizePhase(llm, config, memories, "test", 2000, 2000, 2000);

    expect(result.ops).toEqual({});
    expect(result.usage.output).toBe(0);
  });

  it("returns empty ops on invalid JSON", async () => {
    const llm = new MockLLM();
    llm.response = "not json at all";
    const config = new Config();
    const memories = new MemoryStore();

    const result = await runMemorizePhase(llm, config, memories, "test", 2000, 2000, 2000);

    expect(result.ops).toEqual({});
  });

  it("includes memory details with costs in prompt", async () => {
    const llm = new MockLLM();
    let capturedSystem = "";
    const origChat = llm.chat.bind(llm);
    llm.chat = async (params: ChatParams) => {
      capturedSystem = params.system ?? "";
      return origChat(params);
    };

    const config = new Config();
    const memories = new MemoryStore();
    memories.add("test fact", "semantic", 0.8);

    await runMemorizePhase(llm, config, memories, "a lesson", 3000, 2500, 2000);

    expect(capturedSystem).toContain("a lesson");
    expect(capturedSystem).toContain("test fact");
    expect(capturedSystem).toContain("3000");
    expect(capturedSystem).toContain("2500");
  });
});

// ── applyMemorizeOperations ─────────────────────────────────────────

describe("applyMemorizeOperations", () => {
  it("stores memories", () => {
    const ops: MemorizeOps = {
      store: [{ content: "important fact", type: "semantic", importance: 0.9 }],
    };
    const memories = new MemoryStore();
    const config = new Config();

    const results = applyMemorizeOperations(ops, memories, config);

    expect(results).toHaveLength(1);
    expect(results[0]).toContain("stored");
    expect(memories.memories).toHaveLength(1);
    expect(memories.memories[0]!.content).toBe("important fact");
    expect(memories.memories[0]!.importance).toBe(0.9);
  });

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
    const mem = memories.add("very long verbose description of a fact", "semantic", 0.7);
    const ops: MemorizeOps = { compress: [{ id: mem.id, newContent: "short fact" }] };
    const config = new Config();

    applyMemorizeOperations(ops, memories, config);

    expect(memories.memories[0]!.content).toBe("short fact");
  });

  it("consolidates memories", () => {
    const memories = new MemoryStore();
    const m1 = memories.add("fact A", "semantic", 0.5);
    const m2 = memories.add("fact B", "semantic", 0.6);
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

  it("handles empty ops gracefully", () => {
    const ops: MemorizeOps = {};
    const memories = new MemoryStore();
    const config = new Config();

    const results = applyMemorizeOperations(ops, memories, config);

    expect(results).toHaveLength(0);
  });
});
