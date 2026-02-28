import { describe, it, expect } from "vitest";
import { Config } from "../../src/state/config.js";

describe("Config", () => {
  it("initializes with default prompts", () => {
    const c = new Config();
    expect(c.systemPrompt).toContain("energy");
    expect(c.resolvePrompt).toContain("accomplish");
    expect(c.memorizePrompt).toContain("worth keeping");
    expect(c.version).toBe(0);
  });

  it("rewrite records history and increments version", () => {
    const c = new Config();
    const oldPrompt = c.systemPrompt;
    c.rewrite("systemPrompt", "New system prompt");
    expect(c.systemPrompt).toBe("New system prompt");
    expect(c.version).toBe(1);
    expect(c.promptHistory).toHaveLength(1);
    expect(c.promptHistory[0]!.oldPrompt).toBe(oldPrompt);
    expect(c.promptHistory[0]!.newPrompt).toBe("New system prompt");
    expect(c.promptHistory[0]!.phase).toBe("systemPrompt");
  });

  it("rewrite ignores empty prompts", () => {
    const c = new Config();
    const oldPrompt = c.systemPrompt;
    c.rewrite("systemPrompt", "   ");
    expect(c.systemPrompt).toBe(oldPrompt);
    expect(c.version).toBe(0);
  });

  it("rewrite ignores invalid phases", () => {
    const c = new Config();
    c.rewrite("invalidPhase", "something");
    expect(c.version).toBe(0);
  });

  it("can rewrite all prompt types", () => {
    const c = new Config();
    c.rewrite("resolvePrompt", "new resolve");
    c.rewrite("memorizePrompt", "new memorize");
    expect(c.resolvePrompt).toBe("new resolve");
    expect(c.memorizePrompt).toBe("new memorize");
    expect(c.version).toBe(2);
  });

  it("migrates old routing format with resolve/memorize sub-objects", () => {
    const c = new Config({
      routing: {
        thinking: { model: "claude-sonnet-4-6", maxTokens: 2048, maxCycleCost: 150_000 },
        resolve: { model: "claude-haiku-4-5-20251001", maxTokens: 256 },
        memorize: { model: "claude-haiku-4-5-20251001", maxTokens: 512 },
      } as any,
    });
    expect(c.routing.resolveMaxTokens).toBe(256);
    expect(c.routing.memorizeMaxTokens).toBe(512);
    expect(c.routing.thinking.model).toBe("claude-sonnet-4-6");
    // Old model fields are discarded — no per-phase model routing
    expect((c.routing as any).resolve).toBeUndefined();
    expect((c.routing as any).memorize).toBeUndefined();
  });

  it("passes through new routing format unchanged", () => {
    const c = new Config({
      routing: {
        thinking: { model: "claude-sonnet-4-6", maxTokens: 2048, maxCycleCost: 150_000 },
        resolveMaxTokens: 768,
        memorizeMaxTokens: 2048,
      },
    });
    expect(c.routing.resolveMaxTokens).toBe(768);
    expect(c.routing.memorizeMaxTokens).toBe(2048);
  });

  it("falls back to defaults for missing routing fields", () => {
    const c = new Config({
      routing: {
        thinking: { model: "claude-sonnet-4-6", maxTokens: 2048, maxCycleCost: 150_000 },
      } as any,
    });
    expect(c.routing.resolveMaxTokens).toBe(512);
    expect(c.routing.memorizeMaxTokens).toBe(1024);
  });

  it("serializes and deserializes", () => {
    const c = new Config();
    c.rewrite("systemPrompt", "rewritten prompt");
    const json = c.toJSON();
    const restored = Config.fromJSON(json);
    expect(restored.systemPrompt).toBe("rewritten prompt");
    expect(restored.version).toBe(1);
    expect(restored.promptHistory).toHaveLength(1);
  });
});
