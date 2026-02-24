import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentMode, AgentState } from "../types/index.js";
import { EnergyLedger } from "./energy.js";
import { DriveSystem } from "./drives.js";
import { MemoryStore } from "./memory.js";
import { Config } from "./config.js";

export interface AgentStateInit {
  id?: string;
  generation?: number;
  sourceId?: string | null;
  budget: number;
  reserves?: number;
  thinkingModel?: string;
}

export class AgentStateManager {
  readonly id: string;
  generation: number;
  sourceId: string | null;
  createdAt: number;
  active: boolean;
  stopReason: string | null;
  cycleCount: number;
  mode: AgentMode;
  goal: string | null;

  energy: EnergyLedger;
  drives: DriveSystem;
  memories: MemoryStore;
  config: Config;

  constructor(init: AgentStateInit) {
    this.id = init.id ?? `agent-${randomUUID().slice(0, 8)}`;
    this.generation = init.generation ?? 0;
    this.sourceId = init.sourceId ?? null;
    this.createdAt = Date.now();
    this.active = true;
    this.stopReason = null;
    this.cycleCount = 0;
    this.mode = "active";
    this.goal = null;
    this.energy = new EnergyLedger({
      budget: init.budget,
      reserves: init.reserves ?? init.budget,
    });
    this.drives = new DriveSystem();
    this.memories = new MemoryStore();
    this.config = new Config();
    if (init.thinkingModel) {
      this.config.routing.thinking.model = init.thinkingModel;
    }
  }

  checkVitalSigns(): boolean {
    if (!this.energy.active) {
      this.terminate("energy_depleted");
      return false;
    }
    return this.active;
  }

  terminate(cause: string): void {
    this.active = false;
    this.stopReason = cause;
    this.mode = "stopped";
  }

  restart(budget: number): void {
    this.active = true;
    this.stopReason = null;
    this.mode = "active";
    this.energy = new EnergyLedger({ budget });
    this.cycleCount = 0;
  }

  async save(path: string): Promise<void> {
    const data = this.toJSON();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(data, null, 2), "utf-8");
  }

  static async load(path: string): Promise<AgentStateManager> {
    const raw = await readFile(path, "utf-8");
    const data: AgentState = JSON.parse(raw);
    return AgentStateManager.fromJSON(data);
  }

  toJSON(): AgentState {
    return {
      id: this.id,
      generation: this.generation,
      sourceId: this.sourceId,
      createdAt: this.createdAt,
      active: this.active,
      stopReason: this.stopReason,
      cycleCount: this.cycleCount,
      mode: this.mode,
      goal: this.goal,
      energy: this.energy.toJSON(),
      drives: this.drives.toJSON(),
      memories: this.memories.toJSON(),
      config: this.config.toJSON(),
    };
  }

  static fromJSON(data: AgentState): AgentStateManager {
    const mgr = new AgentStateManager({ id: data.id, budget: data.energy.budget });
    mgr.generation = data.generation;
    mgr.sourceId = data.sourceId;
    mgr.createdAt = data.createdAt;
    mgr.active = data.active;
    mgr.stopReason = data.stopReason;
    mgr.cycleCount = data.cycleCount;
    mgr.mode = data.mode;
    mgr.goal = data.goal;
    mgr.energy = EnergyLedger.fromJSON(data.energy);
    mgr.drives = DriveSystem.fromJSON(data.drives);
    mgr.memories = MemoryStore.fromJSON(data.memories);
    mgr.config = Config.fromJSON(data.config);
    return mgr;
  }
}
