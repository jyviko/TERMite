import { DRIVE_NAMES } from "../types/index.js";
import type { Drive, DriveName, Memory } from "../types/index.js";
import type { EnergyLedger } from "./energy.js";

function defaultDrive(name: DriveName): Drive {
  const configs: Record<DriveName, Omit<Drive, "name">> = {
    explore: { level: 0.8, threshold: 0.3, decayRate: 0.05, growthRate: 0.15 },
    acquire: { level: 0.5, threshold: 0.4, decayRate: 0.03, growthRate: 0.2 },
    grow: { level: 0.0, threshold: 0.5, decayRate: 0.1, growthRate: 0.1 },
    coordinate: { level: 0.0, threshold: 0.6, decayRate: 0.15, growthRate: 0.05 },
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
    if (memories.length < 3) {
      explore.level = Math.min(1, explore.level + explore.growthRate);
    } else {
      explore.level = Math.max(0, explore.level - explore.decayRate);
    }

    const acquire = this.drives.acquire;
    const deficit = 1 - energy.ratio;
    acquire.level = Math.min(1, acquire.level + acquire.growthRate * deficit);
    if (energy.ratio > 0.7) {
      acquire.level = Math.max(0, acquire.level - acquire.decayRate);
    }

    const grow = this.drives.grow;
    const recentCycles = energy.cycleHistory.slice(-3);
    const positiveStreak =
      recentCycles.length >= 3 && recentCycles.every((c) => c.net > 0);
    if (positiveStreak) {
      grow.level = Math.min(1, grow.level + grow.growthRate);
    } else {
      grow.level = Math.max(0, grow.level - grow.decayRate);
    }

    const coordinate = this.drives.coordinate;
    if (cycleCount > 20 && energy.ratio > 0.7) {
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
      grow: "Capacity for expansion.",
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
