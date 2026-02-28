import type { Outcome } from "../types/index.js";
import { ZERO_USAGE, type LLM, type TokenUsage } from "../llm/index.js";
import { extractText } from "../llm/util.js";
import type { Config } from "../state/config.js";
import type { TEQPool } from "../arena/teq-pool.js";
import { DIFFICULTY_EXPECTED_COST } from "../arena/challenge-generator.js";

export interface ResolveResult {
  outcome: Outcome;
  lesson: string;
  goalRelevance: number;
  energyJustified: boolean;
  goalComplete: boolean;
  usage: TokenUsage;
}

const RESOLVE_ERROR_DEFAULT: ResolveResult = {
  outcome: "uncertain",
  lesson: "",
  goalRelevance: 0,
  energyJustified: false,
  goalComplete: false,
  usage: ZERO_USAGE,
};

export class Resolver {
  constructor(private llm: LLM) {}

  async resolve(params: {
    config: Config;
    goal: string;
    actions: string;
    cycleCost: number;
    stateBlock?: string;
  }): Promise<ResolveResult> {
    const prompt = params.config.resolvePrompt
      .replace("{goal}", params.goal)
      .replace("{actions}", params.actions)
      .replace("{cycleCost}", String(params.cycleCost))
      .replace("{stateBlock}", params.stateBlock ?? "");

    try {
      const response = await this.llm.chat({
        model: params.config.routing.resolve.model,
        system: prompt,
        messages: [{ role: "user", content: "Evaluate." }],
        maxTokens: params.config.routing.resolve.maxTokens,
        skipCache: true,
      });

      const text = extractText(response.content);

      return { ...parseResolveResponse(text), usage: response.usage };
    } catch {
      return RESOLVE_ERROR_DEFAULT;
    }
  }
}

function parseResolveResponse(text: string): Omit<ResolveResult, "usage"> {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return RESOLVE_ERROR_DEFAULT;

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      outcome: validateOutcome(parsed.outcome),
      lesson: typeof parsed.lesson === "string" ? parsed.lesson : "",
      goalRelevance: clamp(Number(parsed.value ?? parsed.goalRelevance) || 0, 0, 1),
      energyJustified: parsed.energyJustified === true || parsed.energy_justified === true,
      goalComplete: parsed.goalComplete === true || parsed.goal_complete === true,
    };
  } catch {
    return RESOLVE_ERROR_DEFAULT;
  }
}

function validateOutcome(value: unknown): Outcome {
  const valid: Outcome[] = ["success", "partial", "failure", "uncertain"];
  return valid.includes(value as Outcome) ? (value as Outcome) : "uncertain";
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// Model-dependent bounty multiplier: costlier models earn proportionally more
// to offset their higher per-token energy burn.
const MODEL_BOUNTY_MULTIPLIER: Record<string, number> = {
  "claude-haiku-4-5-20251001": 1.0,
  "claude-haiku-3-5": 1.0,
  "claude-sonnet-4-6": 3.0,
  "claude-sonnet-4-5": 3.0,
  "claude-sonnet-4": 3.0,
  "claude-opus-4-6": 5.0,
  "claude-opus-4-5": 5.0,
};

export function lookupBountyMultiplier(model: string): number {
  // Exact match first
  if (MODEL_BOUNTY_MULTIPLIER[model] !== undefined) return MODEL_BOUNTY_MULTIPLIER[model];
  // Prefix match (handles version suffixes like -20251001)
  for (const [key, multiplier] of Object.entries(MODEL_BOUNTY_MULTIPLIER)) {
    if (model.startsWith(key) || key.startsWith(model)) return multiplier;
  }
  return 1.0;
}

/**
 * Compute per-cycle income: bounty from the shared TEQ pool.
 *
 * No base income — the only way to earn is by solving challenges.
 * This forces agents to seek productive work or conserve energy.
 */
export async function computeIncome(
  _goalRelevance: number,
  _outcome: Outcome,
  taskReward: number | null,
  pool: TEQPool,
  cycleCost?: number,
  taskTier?: number,
  model?: string,
  agentId?: string,
): Promise<{ bounty: number; base: number; requested: number; sources: string[] }> {
  const sources: string[] = [];
  const base = 0;

  // Bounty — task reward withdrawn from pool
  let bountyRequested = 0;
  if (taskReward) {
    bountyRequested = taskReward;
    sources.push(`task:${taskReward}`);

    // Model-dependent multiplier: costlier models get proportionally higher bounties
    if (model) {
      const modelMultiplier = lookupBountyMultiplier(model);
      bountyRequested = Math.floor(bountyRequested * modelMultiplier);
      if (modelMultiplier !== 1.0) {
        sources.push(`model:${modelMultiplier.toFixed(1)}x`);
      }
    }

    // Efficiency bonus: amplify bounty for agents that use tools over in-context reasoning
    // Floor at 1.0 — never reduces bounty, only amplifies for efficient agents
    if (taskTier && cycleCost && cycleCost > 0) {
      const expectedCost = DIFFICULTY_EXPECTED_COST[taskTier] ?? cycleCost;
      const efficiencyRatio = Math.max(1.0, Math.min(3.0, expectedCost / cycleCost));
      bountyRequested = Math.floor(bountyRequested * efficiencyRatio);
      sources.push(`efficiency:${efficiencyRatio.toFixed(2)}x`);
    }
  }

  const bounty = bountyRequested > 0 ? await pool.withdraw(bountyRequested, agentId) : 0;
  const requested = bountyRequested + base;

  return { bounty, base, requested, sources };
}
