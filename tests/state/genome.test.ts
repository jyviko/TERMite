import { describe, it, expect } from "vitest";
import { Genome } from "../../src/state/genome.js";

describe("Genome", () => {
  it("initializes with default prompts", () => {
    const g = new Genome();
    expect(g.systemPrompt).toContain("synthetic organism");
    expect(g.resolvePrompt).toContain("evaluating");
    expect(g.restPrompt).toContain("Compact");
    expect(g.memorizePrompt).toContain("reflective mind");
    expect(g.version).toBe(0);
  });

  it("mutate records history and increments version", () => {
    const g = new Genome();
    const oldPrompt = g.systemPrompt;
    g.mutate("systemPrompt", "New system prompt");
    expect(g.systemPrompt).toBe("New system prompt");
    expect(g.version).toBe(1);
    expect(g.promptHistory).toHaveLength(1);
    expect(g.promptHistory[0]!.oldPrompt).toBe(oldPrompt);
    expect(g.promptHistory[0]!.newPrompt).toBe("New system prompt");
    expect(g.promptHistory[0]!.phase).toBe("systemPrompt");
  });

  it("mutate ignores empty prompts", () => {
    const g = new Genome();
    const oldPrompt = g.systemPrompt;
    g.mutate("systemPrompt", "   ");
    expect(g.systemPrompt).toBe(oldPrompt);
    expect(g.version).toBe(0);
  });

  it("mutate ignores invalid phases", () => {
    const g = new Genome();
    g.mutate("invalidPhase", "something");
    expect(g.version).toBe(0);
  });

  it("can mutate all prompt types", () => {
    const g = new Genome();
    g.mutate("resolvePrompt", "new resolve");
    g.mutate("restPrompt", "new rest");
    g.mutate("memorizePrompt", "new memorize");
    expect(g.resolvePrompt).toBe("new resolve");
    expect(g.restPrompt).toBe("new rest");
    expect(g.memorizePrompt).toBe("new memorize");
    expect(g.version).toBe(3);
  });

  it("serializes and deserializes", () => {
    const g = new Genome();
    g.mutate("systemPrompt", "evolved prompt");
    const json = g.toJSON();
    const restored = Genome.fromJSON(json);
    expect(restored.systemPrompt).toBe("evolved prompt");
    expect(restored.version).toBe(1);
    expect(restored.promptHistory).toHaveLength(1);
  });
});
