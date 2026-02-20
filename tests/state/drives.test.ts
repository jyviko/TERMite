import { describe, it, expect } from "vitest";
import { DriveSystem } from "../../src/state/drives.js";
import { EnergyLedger } from "../../src/state/energy.js";
import type { Memory } from "../../src/types/index.js";

function makeMemory(content: string): Memory {
  return {
    id: `mem_${Math.random().toString(36).slice(2, 8)}`,
    content,
    type: "semantic",
    importance: 0.5,
    accessCount: 0,
    createdAt: Date.now(),
    lastAccessed: Date.now(),
    energySaved: 0,
    tokenCost: 10,
  };
}

describe("DriveSystem", () => {
  it("initializes with default drives", () => {
    const ds = new DriveSystem();
    expect(ds.drives.orient.level).toBe(0.8);
    expect(ds.drives.metabolize.level).toBe(0.5);
    expect(ds.drives.grow.level).toBe(0.0);
    expect(ds.drives.coordinate.level).toBe(0.0);
  });

  it("orient grows when memories < 3", () => {
    const ds = new DriveSystem();
    ds.drives.orient.level = 0.5;
    const energy = new EnergyLedger({ budget: 10000 });
    ds.update(energy, [makeMemory("a")], 0);
    expect(ds.drives.orient.level).toBeGreaterThan(0.5);
  });

  it("orient decays when memories >= 3", () => {
    const ds = new DriveSystem();
    ds.drives.orient.level = 0.8;
    const energy = new EnergyLedger({ budget: 10000 });
    const memories = [makeMemory("a"), makeMemory("b"), makeMemory("c")];
    ds.update(energy, memories, 0);
    expect(ds.drives.orient.level).toBeLessThan(0.8);
  });

  it("metabolize growth scales with deficit", () => {
    const ds = new DriveSystem();
    ds.drives.metabolize.level = 0.3;
    const energy = new EnergyLedger({ budget: 10000 });
    // Burn enough to leave ~20% reserves. Haiku output: 8000 tokens × 5 = 40000 energy
    // But budget is only 10000, so let's use raw input tokens instead (1x multiplier)
    energy.burn("claude-haiku-4-5-20251001", { input: 8000, output: 0, cacheCreation: 0, cacheRead: 0 }); // 8000 × 1 = 8000 energy → 20% remaining
    ds.update(energy, [], 0);
    expect(ds.drives.metabolize.level).toBeGreaterThan(0.3);
  });

  it("grow activates after 3 consecutive positive cycles", () => {
    const ds = new DriveSystem();
    // Start with low reserves so feed actually adds more than burn costs
    const energy = new EnergyLedger({ budget: 10000, reserves: 1000, capacity: 10000 });
    const h = "claude-haiku-4-5-20251001";
    const u = { input: 100, output: 0, cacheCreation: 0, cacheRead: 0 }; // 100 × 1 = 100 energy
    energy.burn(h, u);
    energy.feed(500);
    energy.endCycle(0, "success", 500, "");
    energy.burn(h, u);
    energy.feed(500);
    energy.endCycle(1, "success", 500, "");
    energy.burn(h, u);
    energy.feed(500);
    energy.endCycle(2, "success", 500, "");

    ds.update(energy, [], 3);
    expect(ds.drives.grow.level).toBeGreaterThan(0);
  });

  it("coordinate requires maturity + surplus", () => {
    const ds = new DriveSystem();
    const energy = new EnergyLedger({ budget: 10000 });
    // Not mature enough
    ds.update(energy, [], 5);
    expect(ds.drives.coordinate.level).toBe(0);

    // Mature + surplus
    ds.drives.coordinate.level = 0;
    ds.update(energy, [], 25);
    expect(ds.drives.coordinate.level).toBeGreaterThan(0);
  });

  it("activeDrives returns drives above threshold", () => {
    const ds = new DriveSystem();
    const active = ds.activeDrives();
    // orient=0.8 threshold=0.3, metabolize=0.5 threshold=0.4
    expect(active.length).toBe(2);
    expect(active.map((d) => d.name)).toContain("orient");
    expect(active.map((d) => d.name)).toContain("metabolize");
  });

  it("highestActive returns the drive with highest level", () => {
    const ds = new DriveSystem();
    const highest = ds.highestActive();
    expect(highest?.name).toBe("orient"); // 0.8 > 0.5
  });

  it("driveToGoal returns a goal string", () => {
    const ds = new DriveSystem();
    const goal = ds.driveToGoal(ds.drives.orient);
    expect(goal).toContain("Explore");
  });

  it("serializes and deserializes", () => {
    const ds = new DriveSystem();
    ds.drives.orient.level = 0.42;
    const json = ds.toJSON();
    const restored = DriveSystem.fromJSON(json);
    expect(restored.drives.orient.level).toBe(0.42);
  });
});
