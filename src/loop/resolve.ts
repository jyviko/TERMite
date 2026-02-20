import type { Outcome } from "../types/index.js";
import type { Brain, TokenUsage } from "../brain/index.js";
import { extractText } from "../brain/util.js";
import type { Genome } from "../state/genome.js";
import type { EnergyLedger } from "../state/energy.js";
import type { TEQPool } from "../arena/teq-pool.js";
import { TIER_EXPECTED_COST } from "../arena/task-generator.js";

const ZERO_USAGE: TokenUsage = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };

export interface ResolveResult {
  outcome: Outcome;
  lesson: string;
  goalRelevance: number;
  goalComplete: boolean;
  usage: TokenUsage;
}

const FALLBACK_RESULT: ResolveResult = {
  outcome: "uncertain",
  lesson: "",
  goalRelevance: 0,
  goalComplete: false,
  usage: ZERO_USAGE,
};

export class Resolver {
  constructor(private brain: Brain) {}

  async resolve(params: {
    genome: Genome;
    goal: string;
    actions: string;
    energy: EnergyLedger;
  }): Promise<ResolveResult> {
    const prompt = params.genome.resolvePrompt
      .replace("{goal}", params.goal)
      .replace("{actions}", params.actions)
      .replace("{remaining}", String(params.energy.remaining))
      .replace("{capacity}", String(params.energy.capacity));

    try {
      const response = await this.brain.chat({
        model: params.genome.routing.resolve.model,
        system: prompt,
        messages: [{ role: "user", content: "Evaluate the organism's recent actions." }],
        maxTokens: params.genome.routing.resolve.maxTokens,
      });

      const text = extractText(response.content);

      return { ...parseResolveResponse(text), usage: response.usage };
    } catch {
      return FALLBACK_RESULT;
    }
  }
}

function parseResolveResponse(text: string): Omit<ResolveResult, "usage"> {
  try {
    // Extract JSON from response (may be wrapped in markdown)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return FALLBACK_RESULT;

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      outcome: validateOutcome(parsed.outcome),
      lesson: typeof parsed.lesson === "string" ? parsed.lesson : "",
      goalRelevance: clamp(Number(parsed.goalRelevance) || 0, 0, 1),
      goalComplete: Boolean(parsed.goalComplete),
    };
  } catch {
    return FALLBACK_RESULT;
  }
}

function validateOutcome(value: unknown): Outcome {
  const valid: Outcome[] = ["success", "partial", "failure", "uncertain"];
  return valid.includes(value as Outcome) ? (value as Outcome) : "uncertain";
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export async function computeIncome(
  goalRelevance: number,
  outcome: Outcome,
  taskReward: number | null,
  pool: TEQPool,
  cycleCost?: number,
  taskTier?: number,
): Promise<{ bounty: number; base: number; requested: number; sources: string[] }> {
  const sources: string[] = [];

  // Base income — granted directly, not from pool
  let base = 0;
  if (outcome === "success") {
    base += 5000;
    sources.push("success:5000");
  } else if (outcome === "partial") {
    base += 2000;
    sources.push("partial:2000");
  }
  const relevanceIncome = Math.floor(2500 * goalRelevance);
  if (relevanceIncome > 0) {
    base += relevanceIncome;
    sources.push(`relevance:${relevanceIncome}`);
  }

  // Bounty — task reward withdrawn from pool
  let bountyRequested = 0;
  if (taskReward) {
    bountyRequested = taskReward;
    sources.push(`task:${taskReward}`);

    // Efficiency bonus: amplify bounty for organisms that use tools over in-context reasoning
    // Floor at 1.0 — never reduces bounty, only amplifies for efficient organisms
    if (taskTier && cycleCost && cycleCost > 0) {
      const expectedCost = TIER_EXPECTED_COST[taskTier] ?? cycleCost;
      const efficiencyRatio = Math.max(1.0, Math.min(3.0, expectedCost / cycleCost));
      bountyRequested = Math.floor(bountyRequested * efficiencyRatio);
      sources.push(`efficiency:${efficiencyRatio.toFixed(2)}x`);
    }
  }

  const bounty = bountyRequested > 0 ? await pool.withdraw(bountyRequested) : 0;
  const requested = bountyRequested + base;

  return { bounty, base, requested, sources };
}
