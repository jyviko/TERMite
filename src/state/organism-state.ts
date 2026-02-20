import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { OrganismMode, OrganismState, RoutingTier } from "../types/index.js";
import { EnergyLedger } from "./energy.js";
import { DriveSystem } from "./drives.js";
import { MemoryStore } from "./memory.js";
import { Genome } from "./genome.js";

export interface OrganismStateInit {
  id?: string;
  generation?: number;
  parentId?: string | null;
  budget: number;
  reserves?: number;
  routing?: RoutingTier;
}

export class OrganismStateManager {
  readonly id: string;
  generation: number;
  parentId: string | null;
  bornAt: number;
  alive: boolean;
  causeOfDeath: string | null;
  cycleCount: number;
  mode: OrganismMode;
  goal: string | null;
  routing: RoutingTier;

  energy: EnergyLedger;
  drives: DriveSystem;
  memories: MemoryStore;
  genome: Genome;

  constructor(init: OrganismStateInit) {
    this.id = init.id ?? `org-${randomUUID().slice(0, 8)}`;
    this.generation = init.generation ?? 0;
    this.parentId = init.parentId ?? null;
    this.bornAt = Date.now();
    this.alive = true;
    this.causeOfDeath = null;
    this.cycleCount = 0;
    this.mode = "alive";
    this.goal = null;
    this.routing = init.routing ?? (Math.random() < 0.5 ? "deep" : "fast");
    this.energy = new EnergyLedger({
      budget: init.budget,
      reserves: init.reserves ?? init.budget,
    });
    this.drives = new DriveSystem();
    this.memories = new MemoryStore();
    this.genome = new Genome();
  }

  checkVitalSigns(): boolean {
    if (!this.energy.alive) {
      this.die("energy_depleted");
      return false;
    }
    return this.alive;
  }

  die(cause: string): void {
    this.alive = false;
    this.causeOfDeath = cause;
    this.mode = "dead";
  }

  respawn(budget: number): void {
    this.alive = true;
    this.causeOfDeath = null;
    this.mode = "alive";
    this.energy = new EnergyLedger({ budget });
    this.cycleCount = 0;
  }

  async save(path: string): Promise<void> {
    const data = this.toJSON();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(data, null, 2), "utf-8");
  }

  static async load(path: string): Promise<OrganismStateManager> {
    const raw = await readFile(path, "utf-8");
    const data: OrganismState = JSON.parse(raw);
    return OrganismStateManager.fromJSON(data);
  }

  toJSON(): OrganismState {
    return {
      id: this.id,
      generation: this.generation,
      parentId: this.parentId,
      bornAt: this.bornAt,
      alive: this.alive,
      causeOfDeath: this.causeOfDeath,
      cycleCount: this.cycleCount,
      mode: this.mode,
      goal: this.goal,
      routing: this.routing,
      energy: this.energy.toJSON(),
      drives: this.drives.toJSON(),
      memories: this.memories.toJSON(),
      genome: this.genome.toJSON(),
    };
  }

  static fromJSON(data: OrganismState): OrganismStateManager {
    const mgr = new OrganismStateManager({ id: data.id, budget: data.energy.budget, routing: data.routing });
    mgr.generation = data.generation;
    mgr.parentId = data.parentId;
    mgr.bornAt = data.bornAt;
    mgr.alive = data.alive;
    mgr.causeOfDeath = data.causeOfDeath;
    mgr.cycleCount = data.cycleCount;
    mgr.mode = data.mode;
    mgr.goal = data.goal;
    mgr.energy = EnergyLedger.fromJSON(data.energy);
    mgr.drives = DriveSystem.fromJSON(data.drives);
    mgr.memories = MemoryStore.fromJSON(data.memories);
    mgr.genome = Genome.fromJSON(data.genome);
    return mgr;
  }
}
