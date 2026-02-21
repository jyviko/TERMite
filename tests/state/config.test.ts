import { describe, it, expect } from "vitest";
import { Config } from "../../src/state/config.js";

describe("Config", () => {
  it("initializes with default prompts", () => {
    const c = new Config();
    expect(c.systemPrompt).toContain("energy");
    expect(c.resolvePrompt).toContain("Evaluate");
    expect(c.restPrompt).toContain("Compact");
    expect(c.memorizePrompt).toContain("store");
    expect(c.version).toBe(0);
  });

  it("mutate records history and increments version", () => {
    const c = new Config();
    const oldPrompt = c.systemPrompt;
    c.mutate("systemPrompt", "New system prompt");
    expect(c.systemPrompt).toBe("New system prompt");
    expect(c.version).toBe(1);
    expect(c.promptHistory).toHaveLength(1);
    expect(c.promptHistory[0]!.oldPrompt).toBe(oldPrompt);
    expect(c.promptHistory[0]!.newPrompt).toBe("New system prompt");
    expect(c.promptHistory[0]!.phase).toBe("systemPrompt");
  });

  it("mutate ignores empty prompts", () => {
    const c = new Config();
    const oldPrompt = c.systemPrompt;
    c.mutate("systemPrompt", "   ");
    expect(c.systemPrompt).toBe(oldPrompt);
    expect(c.version).toBe(0);
  });

  it("mutate ignores invalid phases", () => {
    const c = new Config();
    c.mutate("invalidPhase", "something");
    expect(c.version).toBe(0);
  });

  it("can mutate all prompt types", () => {
    const c = new Config();
    c.mutate("resolvePrompt", "new resolve");
    c.mutate("restPrompt", "new rest");
    c.mutate("memorizePrompt", "new memorize");
    expect(c.resolvePrompt).toBe("new resolve");
    expect(c.restPrompt).toBe("new rest");
    expect(c.memorizePrompt).toBe("new memorize");
    expect(c.version).toBe(3);
  });

  it("serializes and deserializes", () => {
    const c = new Config();
    c.mutate("systemPrompt", "evolved prompt");
    const json = c.toJSON();
    const restored = Config.fromJSON(json);
    expect(restored.systemPrompt).toBe("evolved prompt");
    expect(restored.version).toBe(1);
    expect(restored.promptHistory).toHaveLength(1);
  });
});
