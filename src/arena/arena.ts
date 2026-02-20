import { mkdirSync, existsSync, readFileSync, copyFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentEvent, QuestResult } from "../types/index.js";
import { Brain } from "../brain/index.js";
import { Executor } from "../executor/index.js";
import { OrganismStateManager } from "../state/organism-state.js";
import { OrganismStateMachine } from "../loop/state-machine.js";
import { QuestGenerator } from "./quest-generator.js";
import { QuestVerifier } from "./quest-verifier.js";
import { GenomeEvolver } from "./evolution.js";
import { SharedBudget } from "./shared-budget.js";

interface OrganismEntry {
  stateMachine: OrganismStateMachine;
  state: OrganismStateManager;
  executor: Executor;
  questTier: number;
  questHistory: QuestResult[];
  alive: boolean;
  consecutivePasses: number;
  consecutiveFails: number;
}

export interface ArenaConfig {
  organismCount: number;
  totalBudget: number;
  workspaceRoot: string;
  apiKey?: string;
  baseUrl?: string;
}

export class Arena {
  private organisms = new Map<string, OrganismEntry>();
  private brain: Brain;
  private sharedBudget: SharedBudget;
  private questGenerator: QuestGenerator;
  private questVerifier: QuestVerifier;
  private evolver: GenomeEvolver;
  private config: ArenaConfig;

  constructor(config: ArenaConfig) {
    this.config = config;
    this.brain = new Brain({ apiKey: config.apiKey, baseUrl: config.baseUrl });
    this.sharedBudget = new SharedBudget(config.totalBudget);
    this.questGenerator = new QuestGenerator();
    this.questVerifier = new QuestVerifier();
    this.evolver = new GenomeEvolver(this.brain);
  }

  async start(): Promise<void> {
    mkdirSync(this.config.workspaceRoot, { recursive: true });
    mkdirSync(join(this.config.workspaceRoot, "shared"), { recursive: true });

    for (let i = 0; i < this.config.organismCount; i++) {
      await this.spawnOrganism();
    }
  }

  async run(): Promise<void> {
    const promises = Array.from(this.organisms.entries()).map(([id, entry]) =>
      this.runOrganism(id, entry),
    );
    await Promise.allSettled(promises);
  }

  async stop(): Promise<void> {
    const stops = Array.from(this.organisms.values()).map((entry) =>
      entry.executor.stop().catch(() => {}),
    );
    await Promise.allSettled(stops);
  }

  async *events(): AsyncGenerator<{ organismId: string; event: AgentEvent }> {
    // This is a simplified version — in practice you'd use a shared channel
    // For now, events are logged by runOrganism directly
  }

  private async spawnOrganism(
    parentId?: string,
    genome?: import("../state/genome.js").Genome,
  ): Promise<string> {
    const id = `org-${randomUUID().slice(0, 8)}`;
    const workspacePath = join(this.config.workspaceRoot, id, "workspace");
    mkdirSync(workspacePath, { recursive: true });

    const perOrganismBudget = Math.floor(
      this.sharedBudget.available / Math.max(1, this.config.organismCount),
    );

    const state = new OrganismStateManager({
      id,
      budget: perOrganismBudget,
      generation: parentId
        ? (this.organisms.get(parentId)?.state.generation ?? 0) + 1
        : 0,
      parentId: parentId ?? null,
    });

    if (genome) {
      state.genome = genome;
    }

    const executor = new Executor({
      workingDir: workspacePath,
      containerName: `termite-${id}`,
    });

    await executor.start();

    const savePath = join(this.config.workspaceRoot, id, "workspace", "state.json");
    const machine = new OrganismStateMachine(this.brain, executor, state, savePath);

    // Drop initial quest
    const quest = this.questGenerator.generateQuest(1, 0, []);
    this.questGenerator.writeQuestToWorkspace(quest, workspacePath);

    // If child, copy parent's skills
    if (parentId) {
      const parentSkills = join(
        this.config.workspaceRoot,
        parentId,
        "workspace",
        "skills",
      );
      const childSkills = join(workspacePath, "skills");
      if (existsSync(parentSkills)) {
        copyDirectorySync(parentSkills, childSkills);
      }
    }

    const entry: OrganismEntry = {
      stateMachine: machine,
      state,
      executor,
      questTier: 1,
      questHistory: [],
      alive: true,
      consecutivePasses: 0,
      consecutiveFails: 0,
    };

    this.organisms.set(id, entry);
    return id;
  }

  private async runOrganism(id: string, entry: OrganismEntry): Promise<void> {
    try {
      for await (const event of entry.stateMachine.run()) {
        this.logEvent(id, entry.state.mode, event);

        // Check shared budget
        if (this.sharedBudget.exhausted) {
          entry.state.die("arena_budget_exhausted");
          break;
        }

        // Check quest completion periodically
        if (event.type === "tool_result" && event.name === "check_quest") {
          if (event.result.includes("PASS")) {
            await this.onQuestComplete(id, entry);
          }
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${id}] Fatal error: ${msg}`);
    } finally {
      entry.alive = false;
      // Preserve workspace (corpse)
      await entry.state.save(
        join(this.config.workspaceRoot, id, "workspace", "state.json"),
      );
      await entry.executor.stop().catch(() => {});
    }
  }

  private async onQuestComplete(id: string, entry: OrganismEntry): Promise<void> {
    const workspacePath = join(this.config.workspaceRoot, id, "workspace");
    const questPath = join(workspacePath, "quests", "quest.json");

    let quest;
    try {
      quest = JSON.parse(readFileSync(questPath, "utf-8"));
    } catch {
      return;
    }

    // Verify
    const result = await this.questVerifier.verify(quest, entry.executor);
    if (!result.passed) return;

    // Credit energy
    entry.stateMachine.setQuestReward(quest.reward);

    // Record
    entry.questHistory.push({
      questId: quest.id,
      tier: quest.tier,
      passed: true,
      cyclesTaken: entry.state.cycleCount - quest.assignedCycle,
    });
    entry.consecutivePasses++;
    entry.consecutiveFails = 0;

    // Tier escalation: 3 consecutive passes → tier up
    if (entry.consecutivePasses >= 3) {
      entry.questTier = Math.min(10, entry.questTier + 1);
      entry.consecutivePasses = 0;
    }

    // Drop new quest
    const newQuest = this.questGenerator.generateQuest(
      entry.questTier,
      entry.state.cycleCount,
      entry.questHistory.map((q) => q.questId),
    );
    this.questGenerator.writeQuestToWorkspace(newQuest, workspacePath);

    // Check reproduction conditions
    if (
      entry.questTier >= 5 &&
      entry.state.energy.ratio > 0.7 &&
      entry.state.cycleCount > 20
    ) {
      await this.reproduce(id, entry);
    }
  }

  private async reproduce(parentId: string, parent: OrganismEntry): Promise<void> {
    try {
      const evolvedGenome = await this.evolver.evolve({
        parentGenome: parent.state.genome,
        memories: parent.state.memories.memories,
        questHistory: parent.questHistory,
        generation: parent.state.generation,
      });
      await this.spawnOrganism(parentId, evolvedGenome);
      console.log(
        `[ARENA] ${parentId} reproduced → child generation ${parent.state.generation + 1}`,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[ARENA] Reproduction failed for ${parentId}: ${msg}`);
    }
  }

  private logEvent(id: string, mode: string, event: AgentEvent): void {
    const prefix = `[${id}] [${mode.toUpperCase()}]`;
    switch (event.type) {
      case "text":
        console.log(`${prefix} ${event.text.slice(0, 200)}`);
        break;
      case "tool_start":
        console.log(`${prefix} → ${event.name}`);
        break;
      case "tool_result":
        console.log(`${prefix} ← ${event.name}: ${event.result.slice(0, 100)}`);
        break;
      case "state_change":
        console.log(`${prefix} ${event.from} → ${event.to}`);
        break;
      case "error":
        console.error(`${prefix} ERROR: ${event.message}`);
        break;
    }
  }
}

function copyDirectorySync(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  if (!existsSync(src)) return;
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirectorySync(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}
