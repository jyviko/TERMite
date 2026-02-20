import { describe, it, expect } from "vitest";
import { QuestGenerator } from "../../src/arena/quest-generator.js";
import { mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("QuestGenerator", () => {
  const gen = new QuestGenerator();

  it("generates a tier 1 quest", () => {
    const quest = gen.generateQuest(1, 0, []);
    expect(quest.tier).toBe(1);
    expect(quest.id).toMatch(/^quest-/);
    expect(quest.reward).toBeGreaterThan(0);
    expect(quest.deadlineCycles).toBeGreaterThan(0);
  });

  it("generates quests at different tiers", () => {
    for (const tier of [1, 2, 3, 4, 5]) {
      const quest = gen.generateQuest(tier, 0, []);
      expect(quest.tier).toBe(tier);
    }
  });

  it("clamps tier to available range", () => {
    const quest = gen.generateQuest(99, 0, []);
    expect(quest.tier).toBeLessThanOrEqual(10);
    expect(quest.tier).toBeGreaterThanOrEqual(1);
  });

  it("writes quest to workspace correctly", () => {
    const workspace = join(tmpdir(), `termite-test-${Date.now()}`);
    mkdirSync(workspace, { recursive: true });

    const quest = gen.generateQuest(1, 0, []);
    gen.writeQuestToWorkspace(quest, workspace);

    expect(existsSync(join(workspace, "quests", "quest.json"))).toBe(true);
    expect(existsSync(join(workspace, "quests", "verify.sh"))).toBe(true);

    const questJson = JSON.parse(readFileSync(join(workspace, "quests", "quest.json"), "utf-8"));
    expect(questJson.id).toBe(quest.id);

    // Cleanup
    rmSync(workspace, { recursive: true, force: true });
  });

  it("rewards scale with tier", () => {
    const t1 = gen.generateQuest(1, 0, []);
    const t3 = gen.generateQuest(3, 0, []);
    const t5 = gen.generateQuest(5, 0, []);
    expect(t3.reward).toBeGreaterThan(t1.reward);
    expect(t5.reward).toBeGreaterThan(t3.reward);
  });
});
