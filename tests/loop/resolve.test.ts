import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { computeIncome } from "../../src/loop/resolve.js";
import { TEQPool } from "../../src/arena/teq-pool.js";

describe("computeIncome", () => {
  let pool: TEQPool;

  beforeEach(() => {
    TEQPool.reset();
    pool = TEQPool.initialize({ initialBalance: 10_000_000 });
  });

  afterEach(() => {
    TEQPool.reset();
  });

  it("splits task reward (bounty) from base income", async () => {
    const { bounty, base, sources } = await computeIncome(0.5, "partial", 25000, pool);
    // bounty: task:25000 from pool
    // base: partial:2000 + relevance:floor(2500*0.5)=1250
    expect(bounty).toBe(25000);
    expect(base).toBe(2000 + 1250);
    expect(sources).toContain("task:25000");
    expect(sources).toContain("partial:2000");
  });

  it("base income does not touch pool", async () => {
    const { bounty, base } = await computeIncome(0.8, "success", null, pool);
    // No task reward → bounty = 0, pool untouched
    expect(bounty).toBe(0);
    expect(base).toBe(5000 + 2000); // success + relevance
  });

  it("partial outcome gives base income without pool", async () => {
    const { bounty, base, sources } = await computeIncome(0.6, "partial", null, pool);
    expect(bounty).toBe(0);
    expect(base).toBe(2000 + 1500);
    expect(sources).toContain("partial:2000");
  });

  it("zero relevance failure gives zero income", async () => {
    const { bounty, base } = await computeIncome(0, "failure", null, pool);
    expect(bounty).toBe(0);
    expect(base).toBe(0);
  });

  it("full relevance with task and success", async () => {
    const { bounty, base, sources } = await computeIncome(1.0, "success", 60000, pool);
    expect(bounty).toBe(60000); // from pool
    expect(base).toBe(5000 + 2500); // free
    expect(sources).toContain("task:60000");
    expect(sources).toContain("success:5000");
    expect(sources).toContain("relevance:2500");
  });

  it("caps bounty at pool balance, base unaffected", async () => {
    TEQPool.reset();
    const smallPool = TEQPool.initialize({ initialBalance: 100 });
    const { bounty, base, requested } = await computeIncome(1.0, "success", 60000, smallPool);
    expect(bounty).toBe(100); // capped at pool
    expect(base).toBe(5000 + 2500); // still granted in full
    expect(requested).toBe(60000 + 5000 + 2500);
  });

  // ── Efficiency bonus tests ──

  it("efficiency only amplifies bounty, not base", async () => {
    // Tier 1 expected cost: 8000, actual cost: 2000 → ratio = 4.0, capped at 3.0
    const { bounty, base, sources } = await computeIncome(0, "success", 60000, pool, 2000, 1);
    // Bounty: floor(60000 * 3.0) = 180000
    // Base: success:5000 (not amplified)
    expect(bounty).toBe(180000);
    expect(base).toBe(5000);
    expect(sources).toContain("efficiency:3.00x");
  });

  it("floors efficiency at 1.0x (no penalty)", async () => {
    // Tier 1 expected cost: 8000, actual cost: 200000 → floored to 1.0
    const { bounty, base } = await computeIncome(0, "success", 60000, pool, 200000, 1);
    expect(bounty).toBe(60000);
    expect(base).toBe(5000);
  });

  it("no efficiency multiplier without cycleCost", async () => {
    const { bounty, sources } = await computeIncome(0, "success", 60000, pool);
    expect(bounty).toBe(60000);
    expect(sources).not.toContainEqual(expect.stringContaining("efficiency"));
  });

  it("no efficiency multiplier without taskTier", async () => {
    const { bounty, sources } = await computeIncome(0, "success", 60000, pool, 5000);
    expect(bounty).toBe(60000);
    expect(sources).not.toContainEqual(expect.stringContaining("efficiency"));
  });

  it("no efficiency multiplier without taskReward", async () => {
    const { bounty, sources } = await computeIncome(0.5, "success", null, pool, 5000, 1);
    expect(bounty).toBe(0);
    expect(sources).not.toContainEqual(expect.stringContaining("efficiency"));
  });

  it("backward compat — 4 args still works", async () => {
    const { bounty, base } = await computeIncome(0.5, "success", 10000, pool);
    expect(bounty).toBe(10000);
    expect(base).toBe(5000 + 1250);
  });
});
