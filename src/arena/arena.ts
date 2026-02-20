import { mkdirSync, existsSync, readFileSync, copyFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentEvent, ForageRouting, QuestResult } from "../types/index.js";
import { Brain } from "../brain/index.js";
import { Executor } from "../executor/index.js";
import { OrganismStateManager } from "../state/organism-state.js";
import { OrganismStateMachine } from "../loop/state-machine.js";
import { QuestGenerator, TIER_REWARDS } from "./quest-generator.js";
import { QuestVerifier } from "./quest-verifier.js";
import { GenomeEvolver } from "./evolution.js";
import { SharedBudget } from "./shared-budget.js";
import { TEQPool } from "./teq-pool.js";
import { OpenDataGenerator } from "./open-data-generator.js";
import { WorkRater } from "./work-rater.js";

interface OrganismEntry {
  stateMachine: OrganismStateMachine;
  state: OrganismStateManager;
  executor: Executor;
  questTier: number;
  questHistory: QuestResult[];
  alive: boolean;
  consecutivePasses: number;
  consecutiveFails: number;
  graduated: boolean;
  graduationData?: { datasetName: string; files: string[] };
}

export interface ArenaConfig {
  organismCount: number;
  totalBudget: number;
  workspaceRoot: string;
  apiKey?: string;
  baseUrl?: string;
  poolInitialBalance?: number;
  poolRegenPerCycle?: number;
  poolMaxBalance?: number;
}

export class Arena {
  private organisms = new Map<string, OrganismEntry>();
  private brain: Brain;
  private sharedBudget: SharedBudget;
  private teqPool: TEQPool;
  private questGenerator: QuestGenerator;
  private questVerifier: QuestVerifier;
  private evolver: GenomeEvolver;
  private workRater: WorkRater;
  private openDataGenerator: OpenDataGenerator;
  private spawnIndex = 0;
  private config: ArenaConfig;
  private runDir = "";

  constructor(config: ArenaConfig) {
    this.config = config;
    this.brain = new Brain({ apiKey: config.apiKey, baseUrl: config.baseUrl });
    this.sharedBudget = new SharedBudget(config.totalBudget);
    this.teqPool = TEQPool.initialize({
      initialBalance: config.poolInitialBalance,
      regenPerCycle: config.poolRegenPerCycle,
      maxBalance: config.poolMaxBalance,
    });
    this.questGenerator = new QuestGenerator();
    this.questVerifier = new QuestVerifier();
    this.evolver = new GenomeEvolver(this.brain);
    this.workRater = new WorkRater(this.brain);
    this.openDataGenerator = new OpenDataGenerator();
  }

  async start(): Promise<void> {
    // Each run gets its own timestamped directory under workspaceRoot
    const runId = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    this.runDir = join(this.config.workspaceRoot, `run-${runId}`);
    mkdirSync(this.runDir, { recursive: true });
    mkdirSync(join(this.runDir, "shared"), { recursive: true });

    console.log(`Run directory: ${this.runDir}`);

    for (let i = 0; i < this.config.organismCount; i++) {
      await this.spawnOrganism();
    }
  }

  async run(): Promise<void> {
    const poolPath = join(this.runDir, "shared", "_pool.json");

    // Regeneration timer: every 10s, add TEQs and persist pool state
    const regenTimer = setInterval(async () => {
      this.teqPool.regenerate();
      await this.teqPool.persist(poolPath).catch(() => {});
    }, 10_000);

    try {
      const promises = Array.from(this.organisms.entries()).map(([id, entry]) =>
        this.runOrganism(id, entry),
      );
      await Promise.allSettled(promises);
    } finally {
      clearInterval(regenTimer);
      await this.teqPool.persist(poolPath).catch(() => {});
    }
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

  private static readonly ROUTING_TIERS: ForageRouting[] = ["fast", "deep"];

  private async spawnOrganism(
    parentId?: string,
    genome?: import("../state/genome.js").Genome,
    startingReserves?: number,
  ): Promise<string> {
    const id = `org-${randomUUID().slice(0, 8)}`;
    const workspacePath = join(this.runDir, id, "workspace");
    mkdirSync(workspacePath, { recursive: true });

    const perOrganismBudget = startingReserves ?? Math.floor(
      this.sharedBudget.available / Math.max(1, this.config.organismCount),
    );

    // Round-robin routing tier for balanced model distribution
    const forageRouting = Arena.ROUTING_TIERS[this.spawnIndex % Arena.ROUTING_TIERS.length]!;
    this.spawnIndex++;

    const state = new OrganismStateManager({
      id,
      budget: perOrganismBudget,
      reserves: startingReserves,
      forageRouting,
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

    const savePath = join(this.runDir, id, "workspace", "state.json");
    const machine = new OrganismStateMachine(this.brain, executor, state, this.teqPool, savePath);

    // Drop initial quest
    const quest = this.questGenerator.generateQuest(1, 0, []);
    this.questGenerator.writeQuestToWorkspace(quest, workspacePath);

    // If child, copy parent's tools
    if (parentId) {
      const parentTools = join(this.runDir, parentId, "workspace", "tools");
      const childTools = join(workspacePath, "tools");
      if (existsSync(parentTools)) {
        copyDirectorySync(parentTools, childTools);
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
      graduated: false,
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
          if (entry.graduated) {
            // Post-graduation: rate open work instead of verifying quests
            await this.rateGraduateWork(id, entry);
          } else if (event.result.includes("PASS")) {
            await this.onQuestComplete(id, entry);
          }
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${id}] Fatal error: ${msg}`);
    } finally {
      entry.alive = false;

      // Return pool-sourced TEQs on death
      const returnAmount = entry.state.energy.earnedFromPrizes;
      if (returnAmount > 0) {
        this.teqPool.deposit(returnAmount);
      }

      // Preserve workspace (corpse)
      await entry.state.save(
        join(this.runDir, id, "workspace", "state.json"),
      );
      await entry.executor.stop().catch(() => {});
    }
  }

  private async onQuestComplete(id: string, entry: OrganismEntry): Promise<void> {
    const workspacePath = join(this.runDir, id, "workspace");
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
    entry.stateMachine.setQuestReward(quest.reward, quest.tier);

    // Record
    entry.questHistory.push({
      questId: quest.id,
      tier: quest.tier,
      passed: true,
      cyclesTaken: entry.state.cycleCount - quest.assignedCycle,
    });
    entry.consecutivePasses++;
    entry.consecutiveFails = 0;

    // Tier escalation: 3 consecutive passes → tier up (or graduate at tier 5)
    if (entry.consecutivePasses >= 3) {
      if (entry.questTier >= 5) {
        entry.graduated = true;
        entry.consecutivePasses = 0;
        await this.onGraduation(id, entry);
        return; // No more structured quests
      }
      entry.questTier = Math.min(5, entry.questTier + 1);
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

  private async onGraduation(id: string, entry: OrganismEntry): Promise<void> {
    const workspacePath = join(this.runDir, id, "workspace");
    console.log(`[ARENA] ${id} GRADUATED from tier 5 — transitioning to open data`);

    // Place raw data — organism must figure out what to do
    const result = this.openDataGenerator.placeData(workspacePath);
    entry.graduationData = { datasetName: result.datasetName, files: result.files };
  }

  private async rateGraduateWork(id: string, entry: OrganismEntry): Promise<void> {
    const workspacePath = join(this.runDir, id, "workspace");
    const dataDir = join(workspacePath, "data");
    const outputDir = join(workspacePath, "output");

    try {
      const rating = await this.workRater.rate(dataDir, outputDir);
      const baseReward = TIER_REWARDS[5] ?? 300_000;
      const reward = Math.floor(rating.score * baseReward);

      if (reward > 0) {
        entry.stateMachine.setQuestReward(reward, 5);
      }

      console.log(
        `[ARENA] ${id} work rated: score=${rating.score.toFixed(2)} reward=${reward} — ${rating.rationale}`,
      );

      // Good work gets fresh data
      if (rating.score > 0.3) {
        const result = this.openDataGenerator.placeData(workspacePath);
        entry.graduationData = { datasetName: result.datasetName, files: result.files };
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[ARENA] ${id} work rating failed: ${msg}`);
    }
  }

  private async reproduce(parentId: string, parent: OrganismEntry): Promise<void> {
    const INVESTMENT_RATIO = 0.3;
    const MIN_VIABLE_OFFSPRING = 20_000;

    const investment = Math.floor(parent.state.energy.reserves * INVESTMENT_RATIO);
    if (investment < MIN_VIABLE_OFFSPRING) {
      console.log(
        `[ARENA] ${parentId} cannot reproduce: investment ${investment} < minimum ${MIN_VIABLE_OFFSPRING}`,
      );
      return;
    }

    // Deduct investment from parent
    parent.state.energy.burnFlat(investment);

    try {
      const evolvedGenome = await this.evolver.evolve({
        parentGenome: parent.state.genome,
        memories: parent.state.memories.memories,
        questHistory: parent.questHistory,
        generation: parent.state.generation,
      });
      const childId = await this.spawnOrganism(parentId, evolvedGenome, investment);
      console.log(
        `[ARENA] ${parentId} reproduced → ${childId} (gen ${parent.state.generation + 1}, invested ${investment} TEQ)`,
      );

      // Run the child organism concurrently
      const childEntry = this.organisms.get(childId);
      if (childEntry) {
        this.runOrganism(childId, childEntry).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[ARENA] Child ${childId} run failed: ${msg}`);
        });
      }
    } catch (err: unknown) {
      // Refund parent on failure
      parent.state.energy.feed(investment);
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
