import { DRIVE_NAMES } from "../types/index.js";
import type { Drive, DriveName, Memory } from "../types/index.js";
import type { EnergyLedger } from "./energy.js";

function defaultDrive(name: DriveName): Drive {
  const configs: Record<DriveName, Omit<Drive, "name">> = {
    // Explore starts active — agents should explore early
    explore: { level: 0.5, threshold: 0.3, decayRate: 0.06, growthRate: 0.12 },
    // Acquire starts balanced with explore — neither dominates initially
    acquire: { level: 0.5, threshold: 0.3, decayRate: 0.05, growthRate: 0.15 },
    // Grow activates on surplus + accumulated knowledge
    grow: { level: 0.0, threshold: 0.4, decayRate: 0.04, growthRate: 0.12 },
    // Coordinate activates when agent has solved tasks (has something to share)
    coordinate: { level: 0.0, threshold: 0.4, decayRate: 0.04, growthRate: 0.08 },
  };
  return { name, ...configs[name] };
}

export class DriveSystem {
  drives: Record<DriveName, Drive>;

  constructor(drives?: Record<DriveName, Drive>) {
    this.drives = drives ?? DriveSystem.defaultDrives();
  }

  static defaultDrives(): Record<DriveName, Drive> {
    return Object.fromEntries(
      DRIVE_NAMES.map((n) => [n, defaultDrive(n)]),
    ) as Record<DriveName, Drive>;
  }

  update(energy: EnergyLedger, memories: Memory[], cycleCount: number): void {
    const explore = this.drives.explore;
    const acquire = this.drives.acquire;
    const grow = this.drives.grow;
    const coordinate = this.drives.coordinate;

    // ── Explore: rises on OUTCOME STAGNATION (treadmill detection) ──
    // When recent cycles show the same outcomes repeating, the agent
    // needs to try something different. Also rises when procedural
    // memory dominates — crystallized knowledge means it's time for
    // new territory.
    const recent = energy.cycleHistory.slice(-5);
    const outcomes = new Set(recent.map((c) => c.outcome));
    const stagnant = recent.length >= 5 && outcomes.size <= 2;
    const proceduralCount = memories.filter((m) => m.type === "procedural").length;
    const proceduralHeavy = proceduralCount >= 5;

    if (stagnant || proceduralHeavy) {
      explore.level = Math.min(1, explore.level + explore.growthRate);
    } else if (outcomes.size >= 3) {
      // Diverse outcomes = already exploring, relax
      explore.level = Math.max(0, explore.level - explore.decayRate);
    }
    // Otherwise: hold steady (don't decay just because you have memories)

    // ── Acquire: rises with deficit, COUPLED TO EXPLORE ──
    // Suppressing exploration degrades acquisition over time.
    // Agents that never explore become less effective earners.
    const deficit = 1 - energy.ratio;
    const explorePenalty = explore.level < 0.2 ? 0.5 : 1.0;
    acquire.level = Math.min(1, acquire.level + acquire.growthRate * deficit * explorePenalty);
    if (energy.ratio > 0.6) {
      acquire.level = Math.max(0, acquire.level - acquire.decayRate);
    }

    // ── Grow: rises on profitability + accumulated knowledge ──
    // Not just energy surplus — you need something worth propagating.
    // Procedural and semantic memories are inheritable knowledge.
    const window = energy.cycleHistory.slice(-10);
    const windowNet = window.length >= 3
      ? window.reduce((sum, c) => sum + c.net, 0)
      : -1;
    const inheritableKnowledge = memories.filter(
      (m) => m.type === "procedural" || m.type === "semantic",
    ).length;

    if (windowNet > 0 && inheritableKnowledge >= 3) {
      // Profitable AND has knowledge to pass on — strong grow
      grow.level = Math.min(1, grow.level + grow.growthRate);
    } else if (windowNet > 0) {
      // Profitable but no crystallized knowledge — weak grow
      grow.level = Math.min(1, grow.level + grow.growthRate * 0.3);
    } else {
      grow.level = Math.max(0, grow.level - grow.decayRate);
    }

    // ── Coordinate: rises when agent has SOLVED tasks recently ──
    // You need something to share before coordination matters.
    // Replaces the old "cycleCount > 20 && ratio > 0.7" which never fired.
    const recentSuccesses = energy.cycleHistory.slice(-10)
      .filter((c) => c.outcome === "success").length;

    if (recentSuccesses >= 2 && cycleCount >= 10) {
      coordinate.level = Math.min(1, coordinate.level + coordinate.growthRate);
    } else {
      coordinate.level = Math.max(0, coordinate.level - coordinate.decayRate);
    }
  }

  activeDrives(): Drive[] {
    return DRIVE_NAMES
      .map((n) => this.drives[n])
      .filter((d) => d.level >= d.threshold);
  }

  highestActive(): Drive | null {
    const active = this.activeDrives();
    if (active.length === 0) return null;
    return active.reduce((a, b) => (a.level > b.level ? a : b));
  }

  driveToGoal(drive: Drive): string {
    const goals: Record<DriveName, string> = {
      explore: "Unmapped territory detected.",
      acquire: "Energy deficit.",
      grow: "Conditions favor division.",
      coordinate: "Other agents detected.",
    };
    return goals[drive.name];
  }

  toJSON(): Record<DriveName, Drive> {
    return { ...this.drives };
  }

  static fromJSON(data: Record<DriveName, Drive>): DriveSystem {
    return new DriveSystem(data);
  }

  static default(): DriveSystem {
    return new DriveSystem();
  }
}
