import { describe, it, expect } from "vitest";
import { EnergyLedger } from "../../src/state/energy.js";

describe("EnergyLedger", () => {
  it("initializes with correct defaults", () => {
    const e = new EnergyLedger({ budget: 10000 });
    expect(e.budget).toBe(10000);
    expect(e.reserves).toBe(10000);
    expect(e.spent).toBe(0);
    expect(e.alive).toBe(true);
  });

  it("burn reduces reserves and increases spent", () => {
    const e = new EnergyLedger({ budget: 1000 });
    e.burn("test", 300);
    expect(e.reserves).toBe(700);
    expect(e.spent).toBe(300);
    expect(e.remaining).toBe(700);
  });

  it("burn floors reserves at 0", () => {
    const e = new EnergyLedger({ budget: 100 });
    e.burn("test", 200);
    expect(e.reserves).toBe(0);
    expect(e.spent).toBe(200);
  });

  it("feed caps at capacity", () => {
    const e = new EnergyLedger({ budget: 1000 });
    const added = e.feed(500);
    expect(added).toBe(0); // already at capacity
    expect(e.reserves).toBe(1000);
  });

  it("feed adds up to remaining capacity", () => {
    const e = new EnergyLedger({ budget: 1000 });
    e.burn("test", 500);
    const added = e.feed(300);
    expect(added).toBe(300);
    expect(e.reserves).toBe(800);
  });

  it("alive is false when reserves <= 0", () => {
    const e = new EnergyLedger({ budget: 100 });
    e.burn("test", 100);
    expect(e.reserves).toBe(0);
    expect(e.alive).toBe(false);
  });

  it("alive is false when spent >= budget", () => {
    const e = new EnergyLedger({ budget: 100, reserves: 200, capacity: 200 });
    e.burn("test", 100);
    expect(e.alive).toBe(false);
  });

  it("BMR computation matches formula", () => {
    const e = new EnergyLedger({ budget: 10000 });
    const bmr = e.computeBmr(500);
    expect(bmr).toBe(100); // 50 + 500/10
  });

  it("burnBmr uses current BMR", () => {
    const e = new EnergyLedger({ budget: 10000 });
    e.computeBmr(100); // bmr = 60
    e.burnBmr();
    expect(e.reserves).toBe(10000 - 60);
  });

  it("endCycle records cycle history", () => {
    const e = new EnergyLedger({ budget: 10000 });
    e.burn("test", 200);
    e.feed(100);
    e.endCycle(0, "success", 100, "quest:100");
    expect(e.cycleHistory).toHaveLength(1);
    expect(e.cycleHistory[0]!.cost).toBe(200);
    expect(e.cycleHistory[0]!.income).toBe(100);
    expect(e.cycleHistory[0]!.net).toBe(-100);
    expect(e.cycleHistory[0]!.outcome).toBe("success");
  });

  it("avgCycleCost computes correctly", () => {
    const e = new EnergyLedger({ budget: 10000 });
    e.burn("a", 100);
    e.endCycle(0, null, 0, "");
    e.burn("b", 300);
    e.endCycle(1, null, 0, "");
    expect(e.avgCycleCost()).toBe(200);
    expect(e.avgCycleCost(1)).toBe(300);
  });

  it("ratio returns correct value", () => {
    const e = new EnergyLedger({ budget: 1000 });
    e.burn("test", 500);
    expect(e.ratio).toBe(0.5);
  });

  it("serializes and deserializes correctly", () => {
    const e = new EnergyLedger({ budget: 5000 });
    e.burn("test", 1000);
    e.feed(200);
    e.endCycle(0, "partial", 200, "relevance:200");

    const json = e.toJSON();
    const restored = EnergyLedger.fromJSON(json);

    expect(restored.budget).toBe(e.budget);
    expect(restored.spent).toBe(e.spent);
    expect(restored.reserves).toBe(e.reserves);
    expect(restored.earned).toBe(e.earned);
    expect(restored.cycleHistory).toHaveLength(1);
  });
});
