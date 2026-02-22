import { describe, it, expect } from "vitest";
import { Config } from "../../src/state/config.js";

describe("Config", () => {
  it("initializes with default prompts", () => {
    const c = new Config();
    expect(c.systemPrompt).toContain("energy");
    expect(c.resolvePrompt).toContain("Judge");
    expect(c.memorizePrompt).toContain("store");
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
