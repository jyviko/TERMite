import { describe, it, expect } from "vitest";
import { ChallengeGenerator, DIFFICULTY_EXPECTED_COST, DIFFICULTY_REWARDS } from "../../src/arena/challenge-generator.js";
import { ChallengePool } from "../../src/arena/challenge-pool.js";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("ChallengeGenerator", () => {
  const gen = new ChallengeGenerator();

  it("generates a difficulty 1 challenge", () => {
    const result = gen.generate(1, 0);
    expect(result.challenge.difficulty).toBe(1);
    expect(result.challenge.id).toMatch(/^c-/);
    expect(result.challenge.baseReward).toBeGreaterThan(0);
    expect(result.challenge.expiresAtCycle).toBeGreaterThan(0);
    expect(result.challenge.verifyScript).toBeTruthy();
    expect(Object.keys(result.dataFiles).length).toBeGreaterThan(0);
  });

  it("generates challenges at different difficulties", () => {
    for (const diff of [1, 2, 3, 4, 5]) {
      const result = gen.generate(diff, 0);
      expect(result.challenge.difficulty).toBe(diff);
    }
  });

  it("clamps difficulty to valid range", () => {
    const high = gen.generate(99, 0);
    expect(high.challenge.difficulty).toBeLessThanOrEqual(5);
    expect(high.challenge.difficulty).toBeGreaterThanOrEqual(1);

    const low = gen.generate(-5, 0);
    expect(low.challenge.difficulty).toBe(1);
  });

  it("rewards scale with difficulty", () => {
    expect(DIFFICULTY_REWARDS[3]!).toBeGreaterThan(DIFFICULTY_REWARDS[1]!);
    expect(DIFFICULTY_REWARDS[5]!).toBeGreaterThan(DIFFICULTY_REWARDS[3]!);
  });

  it("DIFFICULTY_EXPECTED_COST has entries for difficulties 1-5", () => {
    for (const diff of [1, 2, 3, 4, 5]) {
      expect(DIFFICULTY_EXPECTED_COST[diff]).toBeDefined();
      expect(DIFFICULTY_EXPECTED_COST[diff]).toBeGreaterThan(0);
    }
  });

  it("DIFFICULTY_REWARDS has entries for difficulties 1-5", () => {
    for (const diff of [1, 2, 3, 4, 5]) {
      expect(DIFFICULTY_REWARDS[diff]).toBeDefined();
      expect(DIFFICULTY_REWARDS[diff]).toBeGreaterThan(0);
    }
  });

  it("generateWeighted produces valid challenges", () => {
    // Run multiple times to exercise distribution
    for (let i = 0; i < 10; i++) {
      const result = gen.generateWeighted(i);
      expect(result.challenge.difficulty).toBeGreaterThanOrEqual(1);
      expect(result.challenge.difficulty).toBeLessThanOrEqual(5);
      expect(result.challenge.baseReward).toBeGreaterThan(0);
    }
  });
});

describe("ChallengePool", () => {
  it("first refresh seeds half the target count", () => {
    const sharedDir = join(tmpdir(), `termite-pool-test-${Date.now()}`);
    mkdirSync(join(sharedDir, "challenges"), { recursive: true });
    const pool = new ChallengePool(sharedDir, new ChallengeGenerator());

    // target = 4 + floor(sqrt(4)) = 6, first refresh seeds ceil(6/2) = 3
    pool.refresh(0, 4);
    expect(pool.size).toBe(3);

    rmSync(sharedDir, { recursive: true, force: true });
  });

  it("subsequent refreshes eventually fill to target (stochastic trickle)", () => {
    const sharedDir = join(tmpdir(), `termite-pool-test-stagger-${Date.now()}`);
    mkdirSync(join(sharedDir, "challenges"), { recursive: true });
    const pool = new ChallengePool(sharedDir, new ChallengeGenerator());

    // target = 4 + floor(sqrt(4)) = 6, first refresh seeds 3
    pool.refresh(0, 4);
    expect(pool.size).toBe(3);

    // Subsequent refreshes are stochastic — each tick may add 0, 1, or 2.
    // Track peak size because challenges expire over time (min expiry 15 cycles).
    let maxSize = pool.size;
    for (let cycle = 1; cycle <= 50; cycle++) {
      pool.refresh(cycle, 4);
      if (pool.size > maxSize) maxSize = pool.size;
      expect(pool.size).toBeLessThanOrEqual(6);
    }
    // Pool should have reached target at some point during the 50 ticks
    expect(maxSize).toBe(6);

    rmSync(sharedDir, { recursive: true, force: true });
  });

  it("scan returns formatted challenge list", () => {
    const sharedDir = join(tmpdir(), `termite-pool-scan-${Date.now()}`);
    mkdirSync(join(sharedDir, "challenges"), { recursive: true });
    const pool = new ChallengePool(sharedDir, new ChallengeGenerator());

    pool.refresh(0, 1);
    const scanOutput = pool.scan();
    expect(scanOutput).toContain("Challenges:");
    expect(scanOutput).toContain("difficulty");
    expect(scanOutput).toContain("reward");

    rmSync(sharedDir, { recursive: true, force: true });
  });

  it("persist and restore round-trips pool state", () => {
    const sharedDir = join(tmpdir(), `termite-pool-persist-${Date.now()}`);
    mkdirSync(join(sharedDir, "challenges"), { recursive: true });
    const gen = new ChallengeGenerator();
    const pool = new ChallengePool(sharedDir, gen);

    pool.refresh(5, 2);
    const originalSize = pool.size;
    const originalIds = pool.ids;

    const statePath = join(sharedDir, "challenges", "_state.json");
    pool.persist(statePath);

    const restored = ChallengePool.restore(statePath, sharedDir, gen);
    expect(restored.size).toBe(originalSize);
    expect(restored.ids.sort()).toEqual(originalIds.sort());

    rmSync(sharedDir, { recursive: true, force: true });
  });
});
