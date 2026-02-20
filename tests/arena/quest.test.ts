import { describe, it, expect } from "vitest";
import { QuestGenerator, TIER_EXPECTED_COST, TIER_REWARDS } from "../../src/arena/quest-generator.js";
import { mkdirSync, readFileSync, existsSync, rmSync, statSync } from "node:fs";
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

  it("clamps tier to 5 maximum", () => {
    const quest = gen.generateQuest(99, 0, []);
    expect(quest.tier).toBeLessThanOrEqual(5);
    expect(quest.tier).toBeGreaterThanOrEqual(1);
  });

  it("clamps tier to 1 minimum", () => {
    const quest = gen.generateQuest(-5, 0, []);
    expect(quest.tier).toBe(1);
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

  it("TIER_EXPECTED_COST has entries for tiers 1-5", () => {
    for (const tier of [1, 2, 3, 4, 5]) {
      expect(TIER_EXPECTED_COST[tier]).toBeDefined();
      expect(TIER_EXPECTED_COST[tier]).toBeGreaterThan(0);
    }
    expect(TIER_EXPECTED_COST[6]).toBeUndefined();
  });

  it("TIER_REWARDS has entries for tiers 1-5 only", () => {
    for (const tier of [1, 2, 3, 4, 5]) {
      expect(TIER_REWARDS[tier]).toBeDefined();
      expect(TIER_REWARDS[tier]).toBeGreaterThan(0);
    }
    expect(TIER_REWARDS[6]).toBeUndefined();
  });

  it("data generators produce files of expected sizes", () => {
    const workspace = join(tmpdir(), `termite-test-data-${Date.now()}`);
    mkdirSync(workspace, { recursive: true });

    // Tier 2 quest with data should produce large files
    // Run multiple times to cover different quest types
    for (let i = 0; i < 3; i++) {
      const quest = gen.generateQuest(2, 0, []);
      gen.writeQuestToWorkspace(quest, workspace);

      if (quest.dataFiles && quest.dataFiles.length > 0) {
        for (const file of quest.dataFiles) {
          const filePath = join(workspace, "quests", "data", file);
          expect(existsSync(filePath)).toBe(true);
          const stat = statSync(filePath);
          // Tier 2 data should be substantial (at least 50KB)
          expect(stat.size).toBeGreaterThan(50_000);
        }
      }
    }

    rmSync(workspace, { recursive: true, force: true });
  });
});
