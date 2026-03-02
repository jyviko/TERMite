import { describe, it, expect } from "vitest";
import { DriveSystem } from "../../src/state/drives.js";
import { EnergyLedger } from "../../src/state/energy.js";
import type { Memory, MemoryType } from "../../src/types/index.js";

function makeMemory(
  content: string,
  context = "",
  type: MemoryType = "semantic",
  importance = 0.5,
): Memory {
  return {
    id: `mem_${Math.random().toString(36).slice(2, 8)}`,
    context,
    content,
    type,
    importance,
    accessCount: 0,
    createdAt: Date.now(),
    lastAccessed: Date.now(),
    energySaved: 0,
    tokenCost: 10,
  };
}

function driveSum(ds: DriveSystem): number {
  return ds.drives.explore.level + ds.drives.acquire.level
    + ds.drives.grow.level + ds.drives.coordinate.level;
}

describe("DriveSystem", () => {
  it("initializes with default drives summing to 1", () => {
    const ds = new DriveSystem();
    expect(ds.drives.explore.level).toBeCloseTo(0.40);
    expect(ds.drives.acquire.level).toBeCloseTo(0.40);
    expect(ds.drives.grow.level).toBeCloseTo(0.10);
    expect(ds.drives.coordinate.level).toBeCloseTo(0.10);
    expect(driveSum(ds)).toBeCloseTo(1.0);
  });

  it("sum=1 invariant holds after every update", () => {
    const ds = new DriveSystem();
    const energy = new EnergyLedger({ budget: 10000 });
    const h = "claude-haiku-4-5-20251001";
    const u = { input: 100, output: 0, cacheCreation: 0, cacheRead: 0 };

    // Several cycles with mixed outcomes
    energy.burn(h, u);
    energy.credit(500);
    energy.endCycle(0, "success", "");
    ds.update(energy, [], 1, 0);
    expect(driveSum(ds)).toBeCloseTo(1.0);

    energy.burn(h, u);
    energy.endCycle(1, "failure", "");
    ds.update(energy, [], 2, 0);
    expect(driveSum(ds)).toBeCloseTo(1.0);

    energy.burn(h, u);
    energy.credit(200);
    energy.endCycle(2, "partial", "");
    ds.update(energy, [], 3, 0);
    expect(driveSum(ds)).toBeCloseTo(1.0);
  });

  it("normalizes legacy state on construction", () => {
    // Simulate old-format drives that sum to != 1
    const ds = DriveSystem.fromJSON({
      explore:    { name: "explore", level: 0.5, threshold: 0.3, decayRate: 0.06, growthRate: 0.12 },
      acquire:    { name: "acquire", level: 0.65, threshold: 0.3, decayRate: 0.05, growthRate: 0.15 },
      grow:       { name: "grow", level: 0.0, threshold: 0.4, decayRate: 0.04, growthRate: 0.12 },
      coordinate: { name: "coordinate", level: 0.0, threshold: 0.4, decayRate: 0.04, growthRate: 0.08 },
    });
    expect(driveSum(ds)).toBeCloseTo(1.0);
    // Floor prevents drives at exactly 0
    expect(ds.drives.grow.level).toBeGreaterThan(0);
    expect(ds.drives.coordinate.level).toBeGreaterThan(0);
  });

  it("explore grows on stagnation", () => {
    const ds = new DriveSystem();
    const initialExplore = ds.drives.explore.level;
    const energy = new EnergyLedger({ budget: 10000 });
    // Simulate 5 cycles with identical outcomes → stagnation
    for (let i = 0; i < 5; i++) {
      energy.endCycle(i, "failure", "");
    }
    ds.update(energy, [], 5, 0);
    expect(ds.drives.explore.level).toBeGreaterThan(initialExplore);
  });

  it("explore decays on diverse outcomes", () => {
    const ds = new DriveSystem();
    ds.drives.explore.level = 0.8;
    const energy = new EnergyLedger({ budget: 10000 });
    // Simulate diverse outcomes
    energy.endCycle(0, "success", "");
    energy.endCycle(1, "failure", "");
    energy.endCycle(2, "partial", "");
    energy.endCycle(3, "uncertain", "");
    energy.endCycle(4, "success", "");
    ds.update(energy, [], 5, 0);
    // After normalization with decay pressure, explore's share should drop
    expect(ds.drives.explore.level).toBeLessThan(0.8);
  });

  it("acquire growth scales with deficit", () => {
    const ds = new DriveSystem();
    const initialAcquire = ds.drives.acquire.level;
    const energy = new EnergyLedger({ budget: 10000 });
    energy.burn("claude-haiku-4-5-20251001", { input: 8000, output: 0, cacheCreation: 0, cacheRead: 0 });
    ds.update(energy, [], 0, 0);
    expect(ds.drives.acquire.level).toBeGreaterThan(initialAcquire);
  });

  it("grow rises with profitability", () => {
    const ds = new DriveSystem();
    const initialGrow = ds.drives.grow.level;
    const energy = new EnergyLedger({ budget: 10000, reserves: 1000, capacity: 10000 });
    const h = "claude-haiku-4-5-20251001";
    const u = { input: 100, output: 0, cacheCreation: 0, cacheRead: 0 };
    energy.burn(h, u);
    energy.credit(500);
    energy.endCycle(0, "success", "");

    ds.update(energy, [], 1, 0);
    expect(ds.drives.grow.level).toBeGreaterThan(initialGrow);
  });

  it("grow accelerates with consecutive positive-net cycles", () => {
    const h = "claude-haiku-4-5-20251001";
    const u = { input: 100, output: 0, cacheCreation: 0, cacheRead: 0 };

    // Agent 1: 5 consecutive positive cycles (earning streak)
    const ds = new DriveSystem();
    const energy = new EnergyLedger({ budget: 100000, reserves: 50000, capacity: 100000 });
    for (let i = 0; i < 5; i++) {
      energy.burn(h, u);
      energy.credit(500);
      energy.endCycle(i, "success", "");
    }
    ds.update(energy, [], 5, 0);

    // Agent 2: broken streak (1 positive, 1 negative, 1 positive)
    const ds2 = new DriveSystem();
    const energy2 = new EnergyLedger({ budget: 100000, reserves: 50000, capacity: 100000 });
    energy2.burn(h, u);
    energy2.credit(500);
    energy2.endCycle(0, "success", "");
    energy2.burn(h, u);
    energy2.endCycle(1, "failure", "");
    energy2.burn(h, u);
    energy2.credit(500);
    energy2.endCycle(2, "success", "");
    ds2.update(energy2, [], 3, 0);

    // Streak agent should have higher grow share
    expect(ds.drives.grow.level).toBeGreaterThan(ds2.drives.grow.level);
  });

  it("coordinate activates via explore pathway (stagnation) and grow pathway (surplus)", () => {
    const h = "claude-haiku-4-5-20251001";
    const u = { input: 100, output: 0, cacheCreation: 0, cacheRead: 0 };

    // Stagnation pathway: explore stays high → coordinate gate opens even without surplus
    const dsExplore = new DriveSystem();
    const energyFlat = new EnergyLedger({ budget: 100000, reserves: 50000, capacity: 100000 });
    // No income → grow stays low, explore stays elevated
    dsExplore.update(energyFlat, [], 5, 0);
    expect(dsExplore.drives.explore.level).toBeGreaterThan(dsExplore.drives.explore.threshold);
    expect(dsExplore.drives.coordinate.level).toBeGreaterThan(0.10); // gate opened via explore

    // Surplus pathway: profitable cycles push grow above threshold
    const dsGrow = new DriveSystem();
    const energyRich = new EnergyLedger({ budget: 100000, reserves: 50000, capacity: 100000 });
    for (let i = 0; i < 10; i++) {
      energyRich.burn(h, u);
      energyRich.credit(5000);
      energyRich.endCycle(i, "partial", "");
    }
    dsGrow.update(energyRich, [], 10, 0);
    expect(dsGrow.drives.coordinate.level).toBeGreaterThan(0.10); // gate opened via grow
  });

  it("coordinate gate relaxes with split history", () => {
    const energy = new EnergyLedger({ budget: 100000, reserves: 50000, capacity: 100000 });
    const h = "claude-haiku-4-5-20251001";
    const u = { input: 100, output: 0, cacheCreation: 0, cacheRead: 0 };

    // Profitable cycles to push grow above threshold
    for (let i = 0; i < 10; i++) {
      energy.burn(h, u);
      energy.credit(5000);
      energy.endCycle(i, "partial", "");
    }

    // Cycle 2: gen-0 gate needs cycleCount >= 3 → FAILS at cycle 2
    const ds0 = new DriveSystem();
    ds0.update(energy, [], 2, 0);
    const levelGen0 = ds0.drives.coordinate.level;

    // Cycle 2: gen-1 gate needs cycleCount >= 2 → PASSES at cycle 2
    const ds1 = new DriveSystem();
    ds1.update(energy, [], 2, 1);
    const levelGen1 = ds1.drives.coordinate.level;

    expect(levelGen1).toBeGreaterThan(levelGen0);
  });

  it("normalization creates structural competition between drives", () => {
    const ds = new DriveSystem();
    const energy = new EnergyLedger({ budget: 10000 });
    // Burn most energy → high deficit → acquire grows strongly
    energy.burn("claude-haiku-4-5-20251001", { input: 9000, output: 0, cacheCreation: 0, cacheRead: 0 });

    const growBefore = ds.drives.grow.level;
    ds.update(energy, [], 0, 0);

    // Acquire grew due to deficit; normalization compressed grow
    expect(ds.drives.acquire.level).toBeGreaterThan(ds.drives.grow.level);
    // Grow's share shrank because acquire took more of the budget
    expect(ds.drives.grow.level).toBeLessThan(growBefore);
    expect(driveSum(ds)).toBeCloseTo(1.0);
  });

  it("coordinate exhaustion boosts explore", () => {
    const ds = new DriveSystem();
    ds.drives.coordinate.level = 0.6;
    ds.drives.explore.level = 0.2;

    const energy = new EnergyLedger({ budget: 10000 });
    const h = "claude-haiku-4-5-20251001";
    const u = { input: 100, output: 0, cacheCreation: 0, cacheRead: 0 };

    // Create successes so coordinate gate stays open
    for (let i = 0; i < 3; i++) {
      energy.burn(h, u);
      energy.credit(200);
      energy.endCycle(i, "success", "");
    }

    // Run updates to accumulate coordinateActiveCycles
    for (let i = 0; i < 4; i++) {
      ds.update(energy, [], 15, 0);
    }
    const exploreBefore = ds.drives.explore.level;

    // Run more — fatigue kicks in at coordinateActiveCycles >= 5
    for (let i = 0; i < 4; i++) {
      ds.update(energy, [], 15, 0);
    }
    const exploreAfter = ds.drives.explore.level;

    expect(exploreAfter).toBeGreaterThan(exploreBefore);
  });

  it("activeDrives returns drives above threshold", () => {
    const ds = new DriveSystem();
    const active = ds.activeDrives();
    // explore (0.40) and acquire (0.40) are above threshold (0.25)
    // grow (0.10) is below threshold (0.25); coordinate (0.10) is below threshold (0.15)
    expect(active.length).toBe(2);
    expect(active.map((d) => d.name)).toContain("explore");
    expect(active.map((d) => d.name)).toContain("acquire");
  });

  it("highestActive returns the drive with highest level", () => {
    const ds = new DriveSystem();
    ds.drives.explore.level = 0.9;
    ds.drives.acquire.level = 0.5;
    const highest = ds.highestActive();
    expect(highest?.name).toBe("explore");
  });

  it("driveToGoal returns a goal string", () => {
    const ds = new DriveSystem();
    const goal = ds.driveToGoal(ds.drives.explore);
    expect(goal).toContain("Stagnation");
  });

  it("serializes and deserializes with phase tracking", () => {
    const ds = new DriveSystem();
    ds.drives.explore.level = 0.42;

    const energy = new EnergyLedger({ budget: 10000 });
    const h = "claude-haiku-4-5-20251001";
    const u = { input: 100, output: 0, cacheCreation: 0, cacheRead: 0 };
    for (let i = 0; i < 3; i++) {
      energy.burn(h, u);
      energy.credit(200);
      energy.endCycle(i, "success", "");
    }
    ds.drives.coordinate.level = 0.5; // above threshold
    ds.update(energy, [], 10, 0);

    const json = ds.toJSON();
    const tracking = ds.phaseTrackingToJSON();
    const restored = DriveSystem.fromJSON(json, tracking);

    // Levels are preserved (constructor normalizes, but they already sum to 1)
    expect(restored.drives.explore.level).toBeCloseTo(ds.drives.explore.level);
    expect(driveSum(restored)).toBeCloseTo(1.0);
    expect(restored.phaseTrackingToJSON().coordinateActiveCycles).toBe(
      tracking.coordinateActiveCycles,
    );
  });

  it("deserializes without phase tracking (backward compatible)", () => {
    const ds = new DriveSystem();
    ds.drives.explore.level = 0.42;
    const json = ds.toJSON();
    const restored = DriveSystem.fromJSON(json);
    // Constructor normalizes the restored drives
    expect(driveSum(restored)).toBeCloseTo(1.0);
    expect(restored.phaseTrackingToJSON().coordinateActiveCycles).toBe(0);
  });
});
