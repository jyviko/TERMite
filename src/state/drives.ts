import { DRIVE_NAMES } from "../types/index.js";
import type { CycleRecord, Drive, DriveName, DrivePhaseTracking, Memory } from "../types/index.js";
import type { EnergyLedger } from "./energy.js";

/** Minimum drive level — no drive ever fully dies. */
const DRIVE_FLOOR = 0.01;

function defaultDrive(name: DriveName): Drive {
  const configs: Record<DriveName, Omit<Drive, "name">> = {
    // Explore + acquire start dominant — agents explore and earn early
    explore:    { level: 0.40, threshold: 0.25, decayRate: 0.06, growthRate: 0.12 },
    acquire:    { level: 0.40, threshold: 0.25, decayRate: 0.05, growthRate: 0.15 },
    // Grow + coordinate start latent — activate through conditions
    grow:       { level: 0.10, threshold: 0.25, decayRate: 0.04, growthRate: 0.12 },
    coordinate: { level: 0.10, threshold: 0.15, decayRate: 0.04, growthRate: 0.08 },
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
    // Ensure sum=1 invariant (handles legacy state and rounding)
    this.normalize();
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
    // UPDATE DRIVES: each drive's pressure + post-fork phase transition
    // After all pressures, normalize() enforces sum=1.
    // When one drive rises, others are proportionally compressed.
    // ═══════════════════════════════════════════════════════════════

    const hasSplitHistory = memories.some(
      (m) => m.type === "semantic" &&
        (m.context === "Split" || m.context === "Origin"),
    );
    const hasPostSplitContext = hasSplitHistory || generation > 0;

    // ── Explore: rises on OUTCOME STAGNATION ──
    const recent = energy.cycleHistory.slice(-5);
    const outcomes = new Set(recent.map((c) => c.outcome));
    const stagnant = recent.length >= 5 && outcomes.size <= 2;
    const proceduralCount = memories.filter((m) => m.type === "procedural").length;
    const proceduralHeavy = proceduralCount >= 5;

    if (stagnant || proceduralHeavy) {
      explore.level += explore.growthRate;
    } else if (outcomes.size >= 3) {
      explore.level -= explore.decayRate;
    }

    // ── Acquire: rises with energy deficit ──
    const deficit = 1 - energy.ratio;
    const explorePenalty = explore.level < 0.2 ? 0.5 : 1.0;
    acquire.level += acquire.growthRate * deficit * explorePenalty;
    if (energy.ratio > 0.6) {
      acquire.level -= acquire.decayRate;
    }

    // ── Grow: rises on profitability, decays faster after forking ──
    const window = energy.cycleHistory.slice(-10);
    const windowNet = window.length >= 1
      ? window.reduce((sum, c) => sum + c.net, 0)
      : -1;
    const consecutivePositive = countTrailingPositive(window);
    const earningMomentum = Math.min(2.0, 1.0 + consecutivePositive * 0.15);

    if (windowNet > 0) {
      grow.level += grow.growthRate * earningMomentum;
    } else {
      grow.level -= grow.decayRate;
    }

    // ── Coordinate: rises on surplus (grow) or stagnation (explore) ──
    const coordinateSignal = grow.level >= grow.threshold || explore.level >= explore.threshold;
    const coordinateGate = hasPostSplitContext
      ? (coordinateSignal && cycleCount >= 2)
      : (coordinateSignal && cycleCount >= 3);

    if (coordinateGate) {
      coordinate.level += coordinate.growthRate;
    } else {
      coordinate.level -= coordinate.decayRate;
    }

    // ═══════════════════════════════════════════════════════════════
    // CROSS-DRIVE LINKS: intentional phase transition signals
    // ═══════════════════════════════════════════════════════════════

    // [LINK: Grow → Coordinate] Grow peak + split context → coordinate boost
    if (hasPostSplitContext && grow.level >= grow.threshold) {
      coordinate.level += coordinate.growthRate * 0.5;
    }

    // Sustained coordination fatigue: explore rises, coordinate erodes
    if (this.phaseTracking.coordinateActiveCycles >= 5) {
      const fatigue = Math.min(
        0.08,
        (this.phaseTracking.coordinateActiveCycles - 4) * 0.02,
      );
      explore.level += fatigue;
      coordinate.level -= fatigue;
    }

    // ═══════════════════════════════════════════════════════════════
    // NORMALIZE: conserved quantity — sum of all drives = 1
    // Replaces mutual suppression — competition is structural.
    // ═══════════════════════════════════════════════════════════════
    this.normalize();

    // ── Phase tracking (on normalized values) ──
    if (coordinate.level >= coordinate.threshold) {
      this.phaseTracking.coordinateActiveCycles++;
    } else {
      if (this.phaseTracking.coordinateActiveCycles >= 3) {
        explore.level += explore.growthRate * 0.5;
        this.normalize();
      }
      this.phaseTracking.coordinateActiveCycles = 0;
    }
  }

  /** Clamp all drives to floor then scale so sum = 1. */
  private normalize(): void {
    for (const name of DRIVE_NAMES) {
      this.drives[name].level = Math.max(DRIVE_FLOOR, this.drives[name].level);
    }
    const sum = DRIVE_NAMES.reduce((s, n) => s + this.drives[n].level, 0);
    for (const name of DRIVE_NAMES) {
      this.drives[name].level /= sum;
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
      explore: "Stagnation detected.",
      acquire: "Energy deficit.",
      grow: "Sustained surplus.",
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
