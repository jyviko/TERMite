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

  it("computes quest reward", async () => {
    const { amount, sources } = await computeIncome(0.5, "partial", 25000, pool);
    // quest:25000 + partial:2000 + relevance:floor(2500*0.5)=1250
    expect(amount).toBe(25000 + 2000 + 1250);
    expect(sources).toContain("quest:25000");
    expect(sources).toContain("partial:2000");
  });

  it("adds success bonus", async () => {
    const { amount, sources } = await computeIncome(0.8, "success", null, pool);
    // success:5000 + relevance:floor(2500*0.8)=2000
    expect(amount).toBe(5000 + 2000);
    expect(sources).toContain("success:5000");
  });

  it("partial outcome earns income", async () => {
    const { amount, sources } = await computeIncome(0.6, "partial", null, pool);
    // partial:2000 + relevance:floor(2500*0.6)=1500
    expect(amount).toBe(2000 + 1500);
    expect(sources).toContain("partial:2000");
  });

  it("zero relevance failure gives zero income", async () => {
    const { amount } = await computeIncome(0, "failure", null, pool);
    expect(amount).toBe(0);
  });

  it("full relevance with quest and success", async () => {
    const { amount, sources } = await computeIncome(1.0, "success", 60000, pool);
    expect(amount).toBe(60000 + 5000 + 2500);
    expect(sources).toHaveLength(3);
  });

  it("caps withdrawal at pool balance", async () => {
    TEQPool.reset();
    const smallPool = TEQPool.initialize({ initialBalance: 100 });
    const { amount, requested } = await computeIncome(1.0, "success", 60000, smallPool);
    expect(requested).toBe(60000 + 5000 + 2500);
    expect(amount).toBe(100); // capped at pool balance
  });

  // ── Efficiency bonus tests ──

  it("applies efficiency bonus when under expected cost (capped at 3x)", async () => {
    // Tier 1 expected cost: 8000, actual cost: 2000 → ratio = 4.0, capped at 3.0
    const { requested, sources } = await computeIncome(0, "success", 60000, pool, 2000, 1);
    // Base: quest:60000 + success:5000 = 65000
    // Efficiency: min(3.0, 8000/2000) = 3.0
    // Final: floor(65000 * 3.0) = 195000
    expect(requested).toBe(195000);
    expect(sources).toContain("efficiency:3.00x");
  });

  it("reduces reward when over expected cost", async () => {
    // Tier 1 expected cost: 8000, actual cost: 200000 → ratio = 0.04
    const { requested, sources } = await computeIncome(0, "success", 60000, pool, 200000, 1);
    // Base: 65000
    // Efficiency: 8000/200000 = 0.04
    // Final: floor(65000 * 0.04) = 2600
    expect(requested).toBe(2600);
    expect(sources).toContain("efficiency:0.04x");
  });

  it("no efficiency multiplier without cycleCost", async () => {
    const { requested, sources } = await computeIncome(0, "success", 60000, pool);
    expect(requested).toBe(65000);
    expect(sources).not.toContainEqual(expect.stringContaining("efficiency"));
  });

  it("no efficiency multiplier without questTier", async () => {
    const { requested, sources } = await computeIncome(0, "success", 60000, pool, 5000);
    expect(requested).toBe(65000);
    expect(sources).not.toContainEqual(expect.stringContaining("efficiency"));
  });

  it("no efficiency multiplier without questReward", async () => {
    const { requested, sources } = await computeIncome(0.5, "success", null, pool, 5000, 1);
    // No quest reward → efficiency not applied
    expect(sources).not.toContainEqual(expect.stringContaining("efficiency"));
  });

  it("backward compat — 4 args still works", async () => {
    const { amount } = await computeIncome(0.5, "success", 10000, pool);
    expect(amount).toBe(10000 + 5000 + 1250);
  });
});
