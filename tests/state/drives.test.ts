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

describe("DriveSystem", () => {
  it("initializes with default drives", () => {
    const ds = new DriveSystem();
    expect(ds.drives.explore.level).toBe(0.5);
    expect(ds.drives.acquire.level).toBe(0.5);
    expect(ds.drives.grow.level).toBe(0.0);
    expect(ds.drives.coordinate.level).toBe(0.0);
  });

  it("explore grows on stagnation", () => {
    const ds = new DriveSystem();
    ds.drives.explore.level = 0.5;
    const energy = new EnergyLedger({ budget: 10000 });
    // Simulate 5 cycles with identical outcomes → stagnation
    for (let i = 0; i < 5; i++) {
      energy.endCycle(i, "failure", "");
    }
    ds.update(energy, [], 5, 0);
    expect(ds.drives.explore.level).toBeGreaterThan(0.5);
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
    expect(ds.drives.explore.level).toBeLessThan(0.8);
  });

  it("acquire growth scales with deficit", () => {
    const ds = new DriveSystem();
    ds.drives.acquire.level = 0.3;
    const energy = new EnergyLedger({ budget: 10000 });
    energy.burn("claude-haiku-4-5-20251001", { input: 8000, output: 0, cacheCreation: 0, cacheRead: 0 });
    ds.update(energy, [], 0, 0);
    expect(ds.drives.acquire.level).toBeGreaterThan(0.3);
  });

  it("grow activates after consecutive positive cycles with knowledge", () => {
    const ds = new DriveSystem();
    const energy = new EnergyLedger({ budget: 10000, reserves: 1000, capacity: 10000 });
    const h = "claude-haiku-4-5-20251001";
    const u = { input: 100, output: 0, cacheCreation: 0, cacheRead: 0 };
    energy.burn(h, u);
    energy.credit(500);
    energy.endCycle(0, "success", "");
    energy.burn(h, u);
    energy.credit(500);
    energy.endCycle(1, "success", "");
    energy.burn(h, u);
    energy.credit(500);
    energy.endCycle(2, "success", "");

    ds.update(energy, [], 3, 0);
    expect(ds.drives.grow.level).toBeGreaterThan(0);
  });

  it("grow accelerates with consecutive positive-net cycles", () => {
    const ds = new DriveSystem();
    const energy = new EnergyLedger({ budget: 100000, reserves: 50000, capacity: 100000 });
    const h = "claude-haiku-4-5-20251001";
    const u = { input: 100, output: 0, cacheCreation: 0, cacheRead: 0 };

    // 5 consecutive positive cycles
    for (let i = 0; i < 5; i++) {
      energy.burn(h, u);
      energy.credit(500);
      energy.endCycle(i, "success", "");
    }

    const knowledge = [
      makeMemory("proc1", "", "procedural"),
      makeMemory("proc2", "", "procedural"),
      makeMemory("sem1", "", "semantic"),
    ];

    const ds2 = new DriveSystem();
    const energy2 = new EnergyLedger({ budget: 100000, reserves: 50000, capacity: 100000 });
    // Only 1 positive cycle (no streak)
    energy2.burn(h, u);
    energy2.credit(500);
    energy2.endCycle(0, "success", "");
    energy2.burn(h, u);
    energy2.endCycle(1, "failure", ""); // break the streak
    energy2.burn(h, u);
    energy2.credit(500);
    energy2.endCycle(2, "success", "");

    ds.update(energy, knowledge, 5, 0);
    ds2.update(energy2, knowledge, 3, 0);

    // Agent with earning streak should have higher grow
    expect(ds.drives.grow.level).toBeGreaterThan(ds2.drives.grow.level);
  });

  it("coordinate activates with recent successes and maturity", () => {
    const ds = new DriveSystem();
    const energy = new EnergyLedger({ budget: 10000 });
    // No successes → no coordinate
    ds.update(energy, [], 5, 0);
    expect(ds.drives.coordinate.level).toBe(0);

    // Add successes to history
    const h = "claude-haiku-4-5-20251001";
    const u = { input: 100, output: 0, cacheCreation: 0, cacheRead: 0 };
    for (let i = 0; i < 3; i++) {
      energy.burn(h, u);
      energy.credit(200);
      energy.endCycle(i, "success", "");
    }

    ds.drives.coordinate.level = 0;
    ds.update(energy, [], 10, 0);
    expect(ds.drives.coordinate.level).toBeGreaterThan(0);
  });

  it("coordinate gate relaxes with split history", () => {
    const ds = new DriveSystem();
    const energy = new EnergyLedger({ budget: 10000 });
    const h = "claude-haiku-4-5-20251001";
    const u = { input: 100, output: 0, cacheCreation: 0, cacheRead: 0 };

    // Only 1 success (not enough for gen-0 gate of 2)
    energy.burn(h, u);
    energy.credit(200);
    energy.endCycle(0, "success", "");

    // Gen-0 agent: coordinate should not activate with 1 success at cycle 5
    ds.update(energy, [], 5, 0);
    const levelGen0 = ds.drives.coordinate.level;

    // Gen-1 agent (post-split): coordinate should activate with 1 success at cycle 5
    const ds2 = new DriveSystem();
    ds2.update(energy, [], 5, 1);
    const levelGen1 = ds2.drives.coordinate.level;

    expect(levelGen1).toBeGreaterThan(levelGen0);
  });

  it("non-adjacent drives suppress each other", () => {
    const ds = new DriveSystem();
    // Set explore and grow both above threshold
    ds.drives.explore.level = 0.7;
    ds.drives.grow.level = 0.6;

    const energy = new EnergyLedger({ budget: 10000 });
    // Create stagnation to keep explore growing
    for (let i = 0; i < 5; i++) {
      energy.endCycle(i, "failure", "");
    }
    // Create positive net to keep grow growing
    energy.credit(1000);
    energy.endCycle(5, "success", "");
    energy.credit(1000);
    energy.endCycle(6, "success", "");
    energy.credit(1000);
    energy.endCycle(7, "success", "");

    ds.update(energy, [], 8, 0);

    // Explore is stronger, so grow should be suppressed
    // (explore had 0.7, grow had 0.6 — explore wins)
    // Grow still grows from primary conditions but gets a -0.05 suppression
    // The weaker of the non-adjacent pair gets suppressed
    expect(ds.drives.explore.level).toBeGreaterThan(ds.drives.grow.level);
  });

  it("coordinate exhaustion boosts explore", () => {
    const ds = new DriveSystem();
    ds.drives.coordinate.level = 0.6;
    ds.drives.explore.level = 0.3;

    const energy = new EnergyLedger({ budget: 10000 });
    const h = "claude-haiku-4-5-20251001";
    const u = { input: 100, output: 0, cacheCreation: 0, cacheRead: 0 };

    // Create successes so coordinate stays active
    for (let i = 0; i < 3; i++) {
      energy.burn(h, u);
      energy.credit(200);
      energy.endCycle(i, "success", "");
    }

    // Run a few cycles — coordinate suppresses explore initially (link 4)
    for (let i = 0; i < 4; i++) {
      ds.update(energy, [], 15, 0);
    }
    const exploreBefore = ds.drives.explore.level;

    // Run more cycles — fatigue kicks in at coordinateActiveCycles >= 5
    for (let i = 0; i < 4; i++) {
      ds.update(energy, [], 15, 0);
    }
    const exploreAfter = ds.drives.explore.level;

    // After fatigue kicks in, explore should be rising relative to its suppressed level
    expect(exploreAfter).toBeGreaterThan(exploreBefore);
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
    ds.drives.explore.level = 0.9;
    ds.drives.acquire.level = 0.5;
    const highest = ds.highestActive();
    expect(highest?.name).toBe("explore");
  });

  it("driveToGoal returns a goal string", () => {
    const ds = new DriveSystem();
    const goal = ds.driveToGoal(ds.drives.explore);
    expect(goal).toContain("Unmapped");
  });

  it("serializes and deserializes with phase tracking", () => {
    const ds = new DriveSystem();
    ds.drives.explore.level = 0.42;

    // Simulate some phase tracking state
    const energy = new EnergyLedger({ budget: 10000 });
    const h = "claude-haiku-4-5-20251001";
    const u = { input: 100, output: 0, cacheCreation: 0, cacheRead: 0 };
    for (let i = 0; i < 3; i++) {
      energy.burn(h, u);
      energy.credit(200);
      energy.endCycle(i, "success", "");
    }
    ds.drives.coordinate.level = 0.5; // above threshold
    ds.update(energy, [], 10, 0); // should increment coordinateActiveCycles

    const json = ds.toJSON();
    const tracking = ds.phaseTrackingToJSON();
    const restored = DriveSystem.fromJSON(json, tracking);

    expect(restored.drives.explore.level).toBe(ds.drives.explore.level);
    expect(restored.phaseTrackingToJSON().coordinateActiveCycles).toBe(
      tracking.coordinateActiveCycles,
    );
  });

  it("deserializes without phase tracking (backward compatible)", () => {
    const ds = new DriveSystem();
    ds.drives.explore.level = 0.42;
    const json = ds.toJSON();
    // Old format: no phase tracking
    const restored = DriveSystem.fromJSON(json);
    expect(restored.drives.explore.level).toBe(0.42);
    expect(restored.phaseTrackingToJSON().coordinateActiveCycles).toBe(0);
  });
});
