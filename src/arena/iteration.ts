import type { ChallengeResult, Memory } from "../types/index.js";
import type { LLM } from "../llm/index.js";
import { extractText } from "../llm/util.js";
import { Config } from "../state/config.js";
import type { SeededRng } from "../util/rng.js";

export class ConfigIterator {
  private _random: () => number;

  constructor(private llm: LLM, rng?: SeededRng) {
    this._random = rng ? () => rng.random() : () => Math.random();
  }

  async iterate(params: {
    sourceConfig: Config;
    memories: Memory[];
    challengeHistory: ChallengeResult[];
    generation: number;
  }): Promise<Config> {
    const formattedMemories = params.memories
      .sort((a, b) => b.importance - a.importance)
      .slice(0, 20)
      .map((m) => `[${m.type}] (${m.importance.toFixed(1)}) ${m.content}`)
      .join("\n");

    const formattedChallengeHistory = params.challengeHistory
      .slice(-10)
      .map((q) => `difficulty ${q.difficulty}: ${q.passed ? "PASS" : "FAIL"}, reward ${q.reward}`)
      .join("\n");

    const prompt = `You are iterating an agent's configuration for the next version.

Current config (version ${params.generation}):
${params.sourceConfig.systemPrompt}

Source agent's key memories (sorted by importance):
${formattedMemories || "(none)"}

Challenge history:
${formattedChallengeHistory || "(none)"}

Given what you know from these memories and results — is there anything you would change about this prompt to help you be more efficient? Is there anything you could do better in the next cycle having known what you know now?

Return JSON: { "systemPrompt": "..." }`;

    try {
      const response = await this.llm.chat({
        model: params.sourceConfig.routing.thinking.model,
        system: prompt,
        messages: [{ role: "user", content: "Iterate the configuration." }],
        maxTokens: 2048,
      });

      const text = extractText(response.content);

      const parsed = parseIterateResponse(text);

      // Reject if the iterated prompt is longer than the source — prevents bloat across generations
      const candidatePrompt = parsed.systemPrompt;
      const sourcePrompt = params.sourceConfig.systemPrompt;
      const useCandidate = candidatePrompt != null && candidatePrompt.length <= sourcePrompt.length;

      const next = new Config({
        ...params.sourceConfig.toJSON(),
        systemPrompt: useCandidate ? candidatePrompt : sourcePrompt,
        version: params.sourceConfig.version + 1,
        promptHistory: [],
      });

      applyVariations(next, this._random);

      return next;
    } catch {
      return new Config({
        ...params.sourceConfig.toJSON(),
        version: params.sourceConfig.version + 1,
        promptHistory: [],
      });
    }
  }
}

function parseIterateResponse(text: string): { systemPrompt?: string } {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return {};
    return JSON.parse(jsonMatch[0]);
  } catch {
    return {};
  }
}

const SHUFFLE_PROBABILITY = 0.1;
const DELETION_PROBABILITY = 0.05;

function applyVariations(config: Config, random: () => number): void {
  const sentences = config.systemPrompt.split(/(?<=\.)\s+/);

  if (random() < SHUFFLE_PROBABILITY && sentences.length > 2) {
    const idx = Math.floor(random() * sentences.length);
    const newIdx = Math.floor(random() * sentences.length);
    const [removed] = sentences.splice(idx, 1);
    sentences.splice(newIdx, 0, removed!);
    config.systemPrompt = sentences.join(" ");
  }

  if (random() < DELETION_PROBABILITY && sentences.length > 3) {
    const shortest = sentences.reduce((a, b) => (a.length < b.length ? a : b));
    const idx = sentences.indexOf(shortest);
    if (idx >= 0) sentences.splice(idx, 1);
    config.systemPrompt = sentences.join(" ");
  }
}
