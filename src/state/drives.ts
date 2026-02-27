import { DRIVE_NAMES } from "../types/index.js";
import type { CycleRecord, Drive, DriveName, DrivePhaseTracking, Memory } from "../types/index.js";
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

const DEFAULT_PHASE_TRACKING: DrivePhaseTracking = { coordinateActiveCycles: 0 };

export class DriveSystem {
  drives: Record<DriveName, Drive>;
  private phaseTracking: DrivePhaseTracking;

  constructor(drives?: Record<DriveName, Drive>, phaseTracking?: DrivePhaseTracking) {
    this.drives = drives ?? DriveSystem.defaultDrives();
    this.phaseTracking = phaseTracking ?? { ...DEFAULT_PHASE_TRACKING };
  }

  static defaultDrives(): Record<DriveName, Drive> {
    return Object.fromEntries(
      DRIVE_NAMES.map((n) => [n, defaultDrive(n)]),
    ) as Record<DriveName, Drive>;
  }

  update(energy: EnergyLedger, memories: Memory[], cycleCount: number, generation: number): void {
    const explore = this.drives.explore;
    const acquire = this.drives.acquire;
    const grow = this.drives.grow;
    const coordinate = this.drives.coordinate;

    // ═══════════════════════════════════════════════════════════════
    // PRIMARY CONDITIONS: each drive's individual growth/decay logic
    // ═══════════════════════════════════════════════════════════════

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

    // ── Acquire: rises with deficit, COUPLED TO EXPLORE ──
    const deficit = 1 - energy.ratio;
    const explorePenalty = explore.level < 0.2 ? 0.5 : 1.0;
    acquire.level = Math.min(1, acquire.level + acquire.growthRate * deficit * explorePenalty);
    if (energy.ratio > 0.6) {
      acquire.level = Math.max(0, acquire.level - acquire.decayRate);
    }

    // ── Grow: rises on profitability + accumulated knowledge ──
    const window = energy.cycleHistory.slice(-10);
    const windowNet = window.length >= 3
      ? window.reduce((sum, c) => sum + c.net, 0)
      : -1;
    const inheritableKnowledge = memories.filter(
      (m) => m.type === "procedural" || m.type === "semantic",
    ).length;

    // [LINK: Acquire → Grow] Consecutive positive-net cycles accelerate
    // The transition: sustained earning → conditions favor splitting
    const consecutivePositive = countTrailingPositive(window);
    const earningMomentum = Math.min(2.0, 1.0 + consecutivePositive * 0.15);

    if (windowNet > 0 && inheritableKnowledge >= 3) {
      grow.level = Math.min(1, grow.level + grow.growthRate * earningMomentum);
    } else if (windowNet > 0) {
      grow.level = Math.min(1, grow.level + grow.growthRate * 0.3 * earningMomentum);
    } else {
      grow.level = Math.max(0, grow.level - grow.decayRate);
    }

    // ── Coordinate: rises when agent has SOLVED tasks recently ──
    const recentSuccesses = energy.cycleHistory.slice(-10)
      .filter((c) => c.outcome === "success").length;

    // [LINK: Grow → Coordinate] Split history relaxes the activation gate.
    // Having peers makes coordination relevant even with fewer successes.
    const hasSplitHistory = memories.some(
      (m) => m.type === "semantic" &&
        (m.context === "Split" || m.context === "Origin"),
    );
    const hasPostSplitContext = hasSplitHistory || generation > 0;
    const coordinateGate = hasPostSplitContext
      ? (recentSuccesses >= 1 && cycleCount >= 5)
      : (recentSuccesses >= 2 && cycleCount >= 10);

    if (coordinateGate) {
      coordinate.level = Math.min(1, coordinate.level + coordinate.growthRate);
    } else {
      coordinate.level = Math.max(0, coordinate.level - coordinate.decayRate);
    }

    // ═══════════════════════════════════════════════════════════════
    // CROSS-DRIVE LINKS: phase transition signals
    // Cycle: explore → acquire → grow → coordinate → explore
    // ═══════════════════════════════════════════════════════════════

    // [LINK: Grow → Coordinate] Grow peak + split history → coordinate boost
    if (hasPostSplitContext && grow.level >= grow.threshold) {
      coordinate.level = Math.min(1, coordinate.level + coordinate.growthRate * 0.3);
    }

    // [LINK: Coordinate → Explore] Prolonged coordination → exploration pressure
    if (coordinate.level >= coordinate.threshold) {
      this.phaseTracking.coordinateActiveCycles++;
    } else {
      // Coordinate dropped below threshold — boost explore if it was active long enough
      if (this.phaseTracking.coordinateActiveCycles >= 3) {
        explore.level = Math.min(1, explore.level + explore.growthRate * 0.5);
      }
      this.phaseTracking.coordinateActiveCycles = 0;
    }
    // Sustained coordination creates fatigue: explore rises, coordinate erodes
    if (this.phaseTracking.coordinateActiveCycles >= 5) {
      const fatigue = Math.min(
        0.08,
        (this.phaseTracking.coordinateActiveCycles - 4) * 0.02,
      );
      explore.level = Math.min(1, explore.level + fatigue);
      coordinate.level = Math.max(0, coordinate.level - fatigue);
    }

    // [LINK: Explore ← Coordinate feedback]
    // Active coordination suppresses explore — found what you need through peers
    if (coordinate.level >= coordinate.threshold && coordinate.level > explore.level) {
      explore.level = Math.max(0, explore.level - explore.decayRate * 0.5);
    }

    // ═══════════════════════════════════════════════════════════════
    // MUTUAL SUPPRESSION: non-adjacent drives inhibit each other
    // The stronger of each non-adjacent pair suppresses the weaker.
    // This prevents all four drives from saturating simultaneously.
    // ═══════════════════════════════════════════════════════════════
    const suppressionRate = 0.05;

    // explore ↔ grow (non-adjacent)
    if (explore.level >= explore.threshold && grow.level >= grow.threshold) {
      if (explore.level >= grow.level) {
        grow.level = Math.max(0, grow.level - suppressionRate);
      } else {
        explore.level = Math.max(0, explore.level - suppressionRate);
      }
    }

    // acquire ↔ coordinate (non-adjacent)
    if (acquire.level >= acquire.threshold && coordinate.level >= coordinate.threshold) {
      if (acquire.level >= coordinate.level) {
        coordinate.level = Math.max(0, coordinate.level - suppressionRate);
      } else {
        acquire.level = Math.max(0, acquire.level - suppressionRate);
      }
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

  phaseTrackingToJSON(): DrivePhaseTracking {
    return { ...this.phaseTracking };
  }

  static fromJSON(data: Record<DriveName, Drive>, phaseTracking?: DrivePhaseTracking): DriveSystem {
    return new DriveSystem(data, phaseTracking);
  }

  static default(): DriveSystem {
    return new DriveSystem();
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Count trailing cycles with positive net income (most recent streak). */
function countTrailingPositive(window: CycleRecord[]): number {
  let count = 0;
  for (let i = window.length - 1; i >= 0; i--) {
    if (window[i]!.net > 0) count++;
    else break;
  }
  return count;
}
