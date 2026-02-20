import type { Outcome } from "../types/index.js";
import type { Brain } from "../brain/index.js";
import { extractText } from "../brain/util.js";
import type { Genome } from "../state/genome.js";
import type { EnergyLedger } from "../state/energy.js";

export interface ResolveResult {
  outcome: Outcome;
  lesson: string;
  goalRelevance: number;
  goalComplete: boolean;
}

const FALLBACK_RESULT: ResolveResult = {
  outcome: "uncertain",
  lesson: "",
  goalRelevance: 0,
  goalComplete: false,
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

      return parseResolveResponse(text);
    } catch {
      return FALLBACK_RESULT;
    }
  }
}

function parseResolveResponse(text: string): ResolveResult {
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

export function computeIncome(
  goalRelevance: number,
  outcome: Outcome,
  questReward: number | null,
): { amount: number; sources: string[] } {
  const sources: string[] = [];
  let total = 0;

  if (questReward) {
    total += questReward;
    sources.push(`quest:${questReward}`);
  }

  if (outcome === "success") {
    total += 1000;
    sources.push("success:1000");
  }

  const relevanceIncome = Math.floor(500 * goalRelevance);
  if (relevanceIncome > 0) {
    total += relevanceIncome;
    sources.push(`relevance:${relevanceIncome}`);
  }

  return { amount: total, sources };
}
