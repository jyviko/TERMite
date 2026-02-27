import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Challenge } from "../types/index.js";
import { ChallengeGenerator, DIFFICULTY_EXPECTED_COST } from "./challenge-generator.js";
import type { GeneratedChallenge } from "./challenge-generator.js";
import type { Executor } from "../executor/index.js";
import { lookupBountyMultiplier } from "../loop/resolve.js";

// Depletion: each solve halves the remaining reward
function depletionFactor(solveCount: number): number {
  return Math.pow(0.5, solveCount);
}

export interface ChallengeAttemptResult {
  passed: boolean;
  message: string;
  reward?: number;
  difficulty?: number;
}

interface ChallengePoolState {
  challenges: Challenge[];
  globalCycle: number;
}

export class ChallengePool {
  private challenges = new Map<string, Challenge>();
  private generator: ChallengeGenerator;
  private sharedDir: string;
  private globalCycle = 0;

  constructor(sharedDir: string, generator?: ChallengeGenerator) {
    this.sharedDir = sharedDir;
    this.generator = generator ?? new ChallengeGenerator();
  }

  /** Target number of active challenges: 3 + floor(sqrt(activeAgentCount)). */
  private targetCount(activeAgentCount: number): number {
    return 3 + Math.floor(Math.sqrt(activeAgentCount));
  }

  /**
   * Refresh the challenge pool: remove expired, generate new ones to maintain target count.
   * Called periodically by arena (on regen timer).
   */
  refresh(globalCycle: number, activeAgentCount: number): void {
    this.globalCycle = globalCycle;

    // Remove expired challenges
    for (const [id, challenge] of this.challenges) {
      if (challenge.expiresAtCycle <= globalCycle) {
        this.challenges.delete(id);
      }
    }

    // Generate new challenges to reach target count
    const target = this.targetCount(activeAgentCount);
    while (this.challenges.size < target) {
      const generated = this.generator.generateWeighted(globalCycle);
      this.addChallenge(generated);
    }

    // Persist manifest
    this.persistManifest();
  }

  /** Add a generated challenge: write data files and register it. */
  private addChallenge(generated: GeneratedChallenge): void {
    const { challenge, dataFiles } = generated;

    // Write challenge data to shared dir
    const challengeDir = join(this.sharedDir, challenge.dataDir);
    mkdirSync(challengeDir, { recursive: true });
    for (const [name, content] of Object.entries(dataFiles)) {
      writeFileSync(join(challengeDir, name), content, "utf-8");
    }

    this.challenges.set(challenge.id, challenge);
  }

  /**
   * Scan: return formatted manifest of available challenges.
   * Called when agent runs check with no args.
   */
  scan(): string {
    if (this.challenges.size === 0) {
      return "No challenges available.";
    }

    const lines = ["Challenges:"];
    const sorted = Array.from(this.challenges.values()).sort((a, b) => a.difficulty - b.difficulty);
    for (const c of sorted) {
      const depleted = c.solvedBy.length > 0
        ? `, depleted: ${Math.round(depletionFactor(c.solvedBy.length) * 100)}%`
        : "";
      const expiresIn = c.expiresAtCycle - this.globalCycle;
      lines.push(
        `  ${c.id}: ${c.category}, difficulty ${c.difficulty}, ` +
        `reward ${Math.round(c.baseReward / 1000)}K, ` +
        `expires in ${expiresIn} cycles, ` +
        `${c.solvedBy.length} solve${c.solvedBy.length !== 1 ? "s" : ""}${depleted}`
      );
    }
    return lines.join("\n");
  }

  /**
   * Attempt: verify agent's output for a challenge.
   * Called when agent runs check with a challenge ID.
   */
  async attempt(
    challengeId: string,
    agentId: string,
    executor: Executor,
    model: string,
  ): Promise<ChallengeAttemptResult> {
    const challenge = this.challenges.get(challengeId);
    if (!challenge) {
      return { passed: false, message: `FAIL: unknown challenge ID "${challengeId}"` };
    }

    // Run verify script via executor (inside agent's container)
    try {
      const b64 = Buffer.from(challenge.verifyScript).toString("base64");
      const output = await executor.executeShell(`echo '${b64}' | base64 -d | bash 2>&1`);

      if (output.includes("PASS")) {
        // Compute reward with depletion and model multiplier
        const depletion = depletionFactor(challenge.solvedBy.length);
        const modelMultiplier = lookupBountyMultiplier(model);

        // Efficiency bonus: expected/actual cost, capped at 3.0x
        // (Caller can override if they have the actual cost data)
        const baseReward = challenge.baseReward * depletion * modelMultiplier;
        const reward = Math.floor(baseReward);

        // Record solve
        challenge.solvedBy.push(agentId);
        this.persistManifest();

        return {
          passed: true,
          message: `PASS: ${challengeId} solved. Reward: ${reward.toLocaleString()} TEQ ` +
            `(${Math.round(challenge.baseReward / 1000)}K base × ${modelMultiplier.toFixed(1)} model × ${depletion.toFixed(2)} depletion)`,
          reward,
          difficulty: challenge.difficulty,
        };
      } else {
        return { passed: false, message: output.trim() };
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Return the error output as the fail message (verify scripts output FAIL: ...)
      return { passed: false, message: msg };
    }
  }

  /** Get expected cost for a difficulty level (used by efficiency bonus). */
  getExpectedCost(difficulty: number): number {
    return DIFFICULTY_EXPECTED_COST[difficulty] ?? 180_000;
  }

  /** Persist challenge manifest to shared dir. */
  private persistManifest(): void {
    const manifest = Array.from(this.challenges.values()).map(c => ({
      id: c.id,
      category: c.category,
      difficulty: c.difficulty,
      title: c.title,
      baseReward: c.baseReward,
      expiresAtCycle: c.expiresAtCycle,
      solvedBy: c.solvedBy,
      appearedAtCycle: c.appearedAtCycle,
    }));
    try {
      writeFileSync(
        join(this.sharedDir, "challenges", "_manifest.json"),
        JSON.stringify({ updated: new Date().toISOString(), challenges: manifest }, null, 2),
      );
    } catch {
      // Non-critical
    }
  }

  /** Persist full pool state (including verify scripts) for resume. */
  persist(path: string): void {
    const state: ChallengePoolState = {
      challenges: Array.from(this.challenges.values()),
      globalCycle: this.globalCycle,
    };
    writeFileSync(path, JSON.stringify(state, null, 2));
  }

  /** Restore pool state from a previous run. */
  static restore(path: string, sharedDir: string, generator?: ChallengeGenerator): ChallengePool {
    const pool = new ChallengePool(sharedDir, generator);
    if (!existsSync(path)) return pool;

    try {
      const data: ChallengePoolState = JSON.parse(readFileSync(path, "utf-8"));
      pool.globalCycle = data.globalCycle;
      for (const c of data.challenges) {
        pool.challenges.set(c.id, c);
      }
    } catch {
      // Corrupted state — start fresh
    }
    return pool;
  }

  /** Get current challenge count. */
  get size(): number {
    return this.challenges.size;
  }

  /** Get all challenge IDs. */
  get ids(): string[] {
    return Array.from(this.challenges.keys());
  }
}
