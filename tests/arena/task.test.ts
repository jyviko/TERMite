import { describe, it, expect } from "vitest";
import { TaskGenerator, TIER_EXPECTED_COST, TIER_REWARDS } from "../../src/arena/task-generator.js";
import { mkdirSync, readFileSync, existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("TaskGenerator", () => {
  const gen = new TaskGenerator();

  it("generates a tier 1 task", () => {
    const task = gen.generateTask(1, 0);
    expect(task.tier).toBe(1);
    expect(task.id).toMatch(/^task-/);
    expect(task.reward).toBeGreaterThan(0);
    expect(task.deadlineCycles).toBeGreaterThan(0);
  });

  it("generates tasks at different tiers", () => {
    for (const tier of [1, 2, 3, 4, 5]) {
      const task = gen.generateTask(tier, 0);
      expect(task.tier).toBe(tier);
    }
  });

  it("clamps tier to 5 maximum", () => {
    const task = gen.generateTask(99, 0);
    expect(task.tier).toBeLessThanOrEqual(5);
    expect(task.tier).toBeGreaterThanOrEqual(1);
  });

  it("clamps tier to 1 minimum", () => {
    const task = gen.generateTask(-5, 0);
    expect(task.tier).toBe(1);
  });

  it("writes task to workspace correctly", () => {
    const workspace = join(tmpdir(), `termite-test-${Date.now()}`);
    mkdirSync(workspace, { recursive: true });

    const task = gen.generateTask(1, 0);
    gen.writeTaskToWorkspace(task, workspace);

    expect(existsSync(join(workspace, "tools", "check"))).toBe(true);
    expect(existsSync(join(workspace, "tools", "shell"))).toBe(true);
    expect(existsSync(join(workspace, "data"))).toBe(true);
    expect(task.id).toBeTruthy();

    // Cleanup
    rmSync(workspace, { recursive: true, force: true });
  });

  it("rewards scale with tier", () => {
    const t1 = gen.generateTask(1, 0);
    const t3 = gen.generateTask(3, 0);
    const t5 = gen.generateTask(5, 0);
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

    // Tier 2 task with data should produce large files
    // Run multiple times to cover different task types
    for (let i = 0; i < 3; i++) {
      const task = gen.generateTask(2, 0);
      gen.writeTaskToWorkspace(task, workspace);

      if (task.dataFiles && task.dataFiles.length > 0) {
        for (const file of task.dataFiles) {
          const filePath = join(workspace, "data", file);
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
