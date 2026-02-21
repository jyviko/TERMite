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
    expect(ds.drives.explore.level).toBe(0.8);
    expect(ds.drives.acquire.level).toBe(0.5);
    expect(ds.drives.grow.level).toBe(0.0);
    expect(ds.drives.coordinate.level).toBe(0.0);
  });

  it("explore grows when memories < 3", () => {
    const ds = new DriveSystem();
    ds.drives.explore.level = 0.5;
    const energy = new EnergyLedger({ budget: 10000 });
    ds.update(energy, [makeMemory("a")], 0);
    expect(ds.drives.explore.level).toBeGreaterThan(0.5);
  });

  it("explore decays when memories >= 3", () => {
    const ds = new DriveSystem();
    ds.drives.explore.level = 0.8;
    const energy = new EnergyLedger({ budget: 10000 });
    const memories = [makeMemory("a"), makeMemory("b"), makeMemory("c")];
    ds.update(energy, memories, 0);
    expect(ds.drives.explore.level).toBeLessThan(0.8);
  });

  it("acquire growth scales with deficit", () => {
    const ds = new DriveSystem();
    ds.drives.acquire.level = 0.3;
    const energy = new EnergyLedger({ budget: 10000 });
    energy.burn("claude-haiku-4-5-20251001", { input: 8000, output: 0, cacheCreation: 0, cacheRead: 0 });
    ds.update(energy, [], 0);
    expect(ds.drives.acquire.level).toBeGreaterThan(0.3);
  });

  it("grow activates after 3 consecutive positive cycles", () => {
    const ds = new DriveSystem();
    const energy = new EnergyLedger({ budget: 10000, reserves: 1000, capacity: 10000 });
    const h = "claude-haiku-4-5-20251001";
    const u = { input: 100, output: 0, cacheCreation: 0, cacheRead: 0 };
    energy.burn(h, u);
    energy.feed(500);
    energy.endCycle(0, "success", "");
    energy.burn(h, u);
    energy.feed(500);
    energy.endCycle(1, "success", "");
    energy.burn(h, u);
    energy.feed(500);
    energy.endCycle(2, "success", "");

    ds.update(energy, [], 3);
    expect(ds.drives.grow.level).toBeGreaterThan(0);
  });

  it("coordinate requires maturity + surplus", () => {
    const ds = new DriveSystem();
    const energy = new EnergyLedger({ budget: 10000 });
    ds.update(energy, [], 5);
    expect(ds.drives.coordinate.level).toBe(0);

    ds.drives.coordinate.level = 0;
    ds.update(energy, [], 25);
    expect(ds.drives.coordinate.level).toBeGreaterThan(0);
  });

  it("activeDrives returns drives above threshold", () => {
    const ds = new DriveSystem();
    const active = ds.activeDrives();
    expect(active.length).toBe(2);
    expect(active.map((d) => d.name)).toContain("explore");
    expect(active.map((d) => d.name)).toContain("acquire");
  });

  it("highestActive returns the drive with highest level", () => {
    const ds = new DriveSystem();
    const highest = ds.highestActive();
    expect(highest?.name).toBe("explore");
  });

  it("driveToGoal returns a goal string", () => {
    const ds = new DriveSystem();
    const goal = ds.driveToGoal(ds.drives.explore);
    expect(goal).toContain("Unmapped");
  });

  it("serializes and deserializes", () => {
    const ds = new DriveSystem();
    ds.drives.explore.level = 0.42;
    const json = ds.toJSON();
    const restored = DriveSystem.fromJSON(json);
    expect(restored.drives.explore.level).toBe(0.42);
  });
});
