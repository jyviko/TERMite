import { describe, it, expect } from "vitest";
import { EnergyLedger, computeEnergyCost } from "../../src/state/energy.js";

const HAIKU = "claude-haiku-4-5-20251001";
const SONNET = "claude-sonnet-4-6";

// Helper: build a usage object (defaults to all-output for simplicity)
function usage(output: number, input = 0, cacheCreation = 0, cacheRead = 0) {
  return { input, output, cacheCreation, cacheRead };
}

describe("computeEnergyCost", () => {
  it("charges output at model rate", () => {
    // Haiku output: 5 $/MTok → 100 tokens × 5 = 500
    expect(computeEnergyCost(HAIKU, usage(100))).toBe(500);
    // Sonnet output: 15 $/MTok → 100 tokens × 15 = 1500
    expect(computeEnergyCost(SONNET, usage(100))).toBe(1500);
  });

  it("charges uncached input at base rate", () => {
    // Haiku: 1000 input (no cache) × 1 = 1000
    expect(computeEnergyCost(HAIKU, usage(0, 1000))).toBe(1000);
    // Sonnet: 1000 input × 3 = 3000
    expect(computeEnergyCost(SONNET, usage(0, 1000))).toBe(3000);
  });

  it("cache reads are cheap", () => {
    // 1000 input, all cache read → uncached = 0, cache_read cost = 1000 × 0.1 = 100
    expect(computeEnergyCost(HAIKU, usage(0, 1000, 0, 1000))).toBe(100);
  });

  it("cache creation costs slightly more than base input", () => {
    // 1000 input, all cache creation → uncached = 0, cache_write = 1000 × 1.25 = 1250
    expect(computeEnergyCost(HAIKU, usage(0, 1000, 1000, 0))).toBe(1250);
  });

  it("mixed usage computes correctly", () => {
    // Haiku: 2000 input, 500 output, 500 cache_create, 1000 cache_read
    // uncached = 2000 - 500 - 1000 = 500
    // cost = 500×1 + 500×1.25 + 1000×0.1 + 500×5 = 500 + 625 + 100 + 2500 = 3725
    expect(computeEnergyCost(HAIKU, usage(500, 2000, 500, 1000))).toBe(3725);
  });

  it("falls back to default pricing for unknown models", () => {
    // Unknown model → Haiku pricing
    expect(computeEnergyCost("unknown-model", usage(100))).toBe(500);
  });
});

describe("EnergyLedger", () => {
  it("initializes with correct defaults", () => {
    const e = new EnergyLedger({ budget: 10000 });
    expect(e.budget).toBe(10000);
    expect(e.reserves).toBe(10000);
    expect(e.spent).toBe(0);
    expect(e.active).toBe(true);
  });

  it("burn reduces reserves by weighted cost", () => {
    const e = new EnergyLedger({ budget: 100000 });
    // 100 Haiku output tokens → 100 × 5 = 500 energy
    e.burn(HAIKU, usage(100));
    expect(e.reserves).toBe(99500);
    expect(e.spent).toBe(500);
    expect(e.remaining).toBe(99500);
  });

  it("burn floors reserves at 0", () => {
    const e = new EnergyLedger({ budget: 100 });
    // 100 Haiku output tokens → 500 energy (exceeds budget)
    e.burn(HAIKU, usage(100));
    expect(e.reserves).toBe(0);
    expect(e.spent).toBe(500);
  });

  it("credit grows capacity when reserves exceed it", () => {
    const e = new EnergyLedger({ budget: 1000 });
    const added = e.credit(500);
    expect(added).toBe(500); // no cap — agents accumulate wealth
    expect(e.reserves).toBe(1500);
    expect(e.capacity).toBe(1500); // capacity grew
  });

  it("credit adds up to remaining capacity", () => {
    const e = new EnergyLedger({ budget: 10000 });
    e.burn(HAIKU, usage(100)); // costs 500
    const added = e.credit(300);
    expect(added).toBe(300);
    expect(e.reserves).toBe(9800); // 10000 - 500 + 300
  });

  it("active is false when reserves <= 0", () => {
    const e = new EnergyLedger({ budget: 100 });
    e.burn(HAIKU, usage(100)); // costs 500, reserves → 0
    expect(e.reserves).toBe(0);
    expect(e.active).toBe(false);
  });

  it("active depends on reserves, not budget (agents earn their way)", () => {
    // Budget is a starting allocation, not a lifetime cap.
    // Agents that earn income keep running as long as reserves > 0.
    const e = new EnergyLedger({ budget: 100, reserves: 10000, capacity: 10000 });
    e.burn(HAIKU, usage(100)); // costs 500, spent=500 >= budget=100, but reserves=9500
    expect(e.active).toBe(true); // still active — has reserves
  });

  it("baseCost computation matches formula", () => {
    const e = new EnergyLedger({ budget: 10000 });
    const baseCost = e.computeBaseCost(500);
    expect(baseCost).toBe(100); // 50 + 500/10
  });

  it("burnBaseCost uses current base cost", () => {
    const e = new EnergyLedger({ budget: 10000 });
    e.computeBaseCost(100); // baseCost = 60
    e.burnBaseCost();
    expect(e.reserves).toBe(10000 - 60);
  });

  it("endCycle records cycle history with token breakdown", () => {
    const e = new EnergyLedger({ budget: 100000 });
    e.burn(HAIKU, usage(200, 1000, 0, 500));
    e.credit(100);
    e.endCycle(0, "success", "task:100");
    expect(e.cycleHistory).toHaveLength(1);
    const record = e.cycleHistory[0]!;
    expect(record.income).toBe(100);
    expect(record.outcome).toBe("success");
    expect(record.inputTokens).toBe(1000);
    expect(record.outputTokens).toBe(200);
    expect(record.cacheReadTokens).toBe(500);
  });

  it("tracks cache write cost separately from total cycle cost", () => {
    const e = new EnergyLedger({ budget: 500000 });
    // Sonnet: 6000 cache creation × 3.75 = 22500 TEQ cache write
    // Uncached input: (6200 - 6000) = 200 × 3 = 600 TEQ
    // Output: 200 × 15 = 3000 TEQ
    // Total: 22500 + 600 + 3000 = 26100
    e.burn(SONNET, usage(200, 6200, 6000, 0));
    expect(e.currentCycleCost).toBe(26100);
    expect(e.currentCycleCacheWriteCost).toBe(22500);
    expect(e.currentCycleVariableCost).toBe(3600);
  });

  it("variable cost accumulates across multiple burns in same cycle", () => {
    const e = new EnergyLedger({ budget: 500000 });
    // First burn: cache write (infrastructure)
    e.burn(SONNET, usage(100, 6100, 6000, 0));
    // cache write: 6000 × 3.75 = 22500, uncached input: 100 × 3 = 300, output: 100 × 15 = 1500
    // total = 24300, cache write = 22500, variable = 1800

    // Second burn: cache read (cheap) + output (cognition)
    e.burn(SONNET, usage(500, 5000, 0, 5000));
    // cache read: 5000 × 0.3 = 1500, output: 500 × 15 = 7500
    // total = 9000, cache write = 0, variable = 9000

    expect(e.currentCycleCacheWriteCost).toBe(22500);
    expect(e.currentCycleVariableCost).toBe(24300 + 9000 - 22500);
  });

  it("endCycle persists cacheWriteCost in CycleRecord and resets accumulators", () => {
    const e = new EnergyLedger({ budget: 500000 });
    e.burn(SONNET, usage(200, 6200, 6000, 0));
    e.endCycle(0, "success", "test");
    const record = e.cycleHistory[0]!;
    expect(record.cacheWriteCost).toBe(22500);
    // Accumulators reset
    expect(e.currentCycleCost).toBe(0);
    expect(e.currentCycleCacheWriteCost).toBe(0);
    expect(e.currentCycleVariableCost).toBe(0);
  });

  it("avgCycleCost computes correctly", () => {
    const e = new EnergyLedger({ budget: 100000 });
    e.burn(HAIKU, usage(100)); // 500
    e.endCycle(0, null, "");
    e.burn(HAIKU, usage(200)); // 1000
    e.endCycle(1, null, "");
    expect(e.avgCycleCost()).toBe(750); // (500 + 1000) / 2
    expect(e.avgCycleCost(1)).toBe(1000);
  });

  it("ratio returns correct value", () => {
    const e = new EnergyLedger({ budget: 10000 });
    e.burn(HAIKU, usage(1000)); // 5000
    expect(e.ratio).toBe(0.5);
  });

  it("serializes and deserializes correctly", () => {
    const e = new EnergyLedger({ budget: 100000 });
    e.burn(HAIKU, usage(200));
    e.credit(200);
    e.endCycle(0, "partial", "relevance:200");

    const json = e.toJSON();
    const restored = EnergyLedger.fromJSON(json);

    expect(restored.budget).toBe(e.budget);
    expect(restored.spent).toBe(e.spent);
    expect(restored.reserves).toBe(e.reserves);
    expect(restored.earned).toBe(e.earned);
    // cycleHistory is omitted from toJSON — metrics.jsonl is the SSoT
    expect(restored.cycleHistory).toHaveLength(0);
    // In-memory history still works
    expect(e.cycleHistory).toHaveLength(1);
  });
});
