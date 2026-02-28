import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { computeIncome, parseResolveResponse, RESOLVE_ERROR_DEFAULT } from "../../src/loop/resolve.js";
import { TEQPool } from "../../src/arena/teq-pool.js";

describe("parseResolveResponse", () => {
  it("parses valid JSON response", () => {
    const result = parseResolveResponse('{"outcome":"success","value":0.8,"energyJustified":true,"lesson":"found the file","goalComplete":false}');
    expect(result.outcome).toBe("success");
    expect(result.goalRelevance).toBe(0.8);
    expect(result.energyJustified).toBe(true);
    expect(result.lesson).toBe("found the file");
    expect(result.goalComplete).toBe(false);
  });

  it("extracts JSON from surrounding text", () => {
    const result = parseResolveResponse('Here is my assessment:\n{"outcome":"partial","value":0.5,"energyJustified":false,"lesson":"tried","goalComplete":false}\nDone.');
    expect(result.outcome).toBe("partial");
    expect(result.goalRelevance).toBe(0.5);
  });

  it("handles snake_case fields", () => {
    const result = parseResolveResponse('{"outcome":"failure","value":0.1,"energy_justified":true,"lesson":"x","goal_complete":true}');
    expect(result.energyJustified).toBe(true);
    expect(result.goalComplete).toBe(true);
  });

  it("returns defaults for invalid JSON", () => {
    const result = parseResolveResponse("not json");
    expect(result).toEqual(RESOLVE_ERROR_DEFAULT);
  });

  it("returns defaults for empty string", () => {
    const result = parseResolveResponse("");
    expect(result).toEqual(RESOLVE_ERROR_DEFAULT);
  });

  it("clamps goalRelevance to 0-1", () => {
    const result = parseResolveResponse('{"outcome":"success","value":5.0,"energyJustified":true,"lesson":"x","goalComplete":false}');
    expect(result.goalRelevance).toBe(1);
  });

  it("validates outcome enum", () => {
    const result = parseResolveResponse('{"outcome":"bogus","value":0.5,"energyJustified":true,"lesson":"x","goalComplete":false}');
    expect(result.outcome).toBe("uncertain");
  });
});

describe("computeIncome", () => {
  let pool: TEQPool;

  beforeEach(() => {
    TEQPool.reset();
    pool = TEQPool.initialize({ initialBalance: 10_000_000 });
  });

  afterEach(() => {
    TEQPool.reset();
  });

  it("no base income — only bounty from challenges", async () => {
    const { bounty, base, sources } = await computeIncome(0.5, "partial", 25000, pool);
    expect(bounty).toBe(25000);
    expect(base).toBe(0);
    expect(sources).toContain("task:25000");
  });

  it("no task reward means zero income", async () => {
    const { bounty, base } = await computeIncome(0.8, "success", null, pool);
    expect(bounty).toBe(0);
    expect(base).toBe(0);
  });

  it("failure without task gives zero", async () => {
    const { bounty, base } = await computeIncome(0, "failure", null, pool);
    expect(bounty).toBe(0);
    expect(base).toBe(0);
  });

  it("caps bounty at pool balance", async () => {
    TEQPool.reset();
    const smallPool = TEQPool.initialize({ initialBalance: 100 });
    const { bounty, base, requested } = await computeIncome(1.0, "success", 60000, smallPool);
    expect(bounty).toBe(100);
    expect(base).toBe(0);
    expect(requested).toBe(60000);
  });

  it("efficiency amplifies bounty", async () => {
    const { bounty, base, sources } = await computeIncome(0, "success", 60000, pool, 2000, 1);
    expect(bounty).toBe(180000);
    expect(base).toBe(0);
    expect(sources).toContain("efficiency:3.00x");
  });

  it("floors efficiency at 1.0x (no penalty)", async () => {
    const { bounty, base } = await computeIncome(0, "success", 60000, pool, 200000, 1);
    expect(bounty).toBe(60000);
    expect(base).toBe(0);
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
    expect(base).toBe(0);
  });
});
