import type { TaskResult, Memory } from "../types/index.js";
import type { LLM } from "../llm/index.js";
import { extractText } from "../llm/util.js";
import { Config } from "../state/config.js";

export class ConfigIterator {
  constructor(private llm: LLM) {}

  async iterate(params: {
    sourceConfig: Config;
    memories: Memory[];
    taskHistory: TaskResult[];
    generation: number;
  }): Promise<Config> {
    const formattedMemories = params.memories
      .sort((a, b) => b.importance - a.importance)
      .slice(0, 20)
      .map((m) => `[${m.type}] (${m.importance.toFixed(1)}) ${m.content}`)
      .join("\n");

    const formattedTaskHistory = params.taskHistory
      .slice(-10)
      .map((q) => `tier ${q.tier}: ${q.passed ? "PASS" : "FAIL"} in ${q.cyclesTaken} cycles`)
      .join("\n");

    const prompt = `You are iterating an agent's configuration for the next version.

Current config (version ${params.generation}):
${params.sourceConfig.systemPrompt}

Source agent's key memories (sorted by importance):
${formattedMemories || "(none)"}

Task history:
${formattedTaskHistory || "(none)"}

Create an improved system prompt for the next version. It should:
1. Carry forward successful strategies
2. Start with better defaults than the previous version
3. Encode known pitfalls to avoid
4. Be concise — every token in the config costs energy every cycle

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

      const next = new Config({
        ...params.sourceConfig.toJSON(),
        systemPrompt: parsed.systemPrompt ?? params.sourceConfig.systemPrompt,
        version: params.sourceConfig.version + 1,
        promptHistory: [],
      });

      applyRewrites(next);

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

function applyRewrites(config: Config): void {
  const sentences = config.systemPrompt.split(/(?<=\.)\s+/);

  // 10% chance: shuffle one sentence
  if (Math.random() < 0.1 && sentences.length > 2) {
    const idx = Math.floor(Math.random() * sentences.length);
    const newIdx = Math.floor(Math.random() * sentences.length);
    const [removed] = sentences.splice(idx, 1);
    sentences.splice(newIdx, 0, removed!);
    config.systemPrompt = sentences.join(" ");
  }

  // 5% chance: remove shortest sentence
  if (Math.random() < 0.05 && sentences.length > 3) {
    const shortest = sentences.reduce((a, b) => (a.length < b.length ? a : b));
    const idx = sentences.indexOf(shortest);
    if (idx >= 0) sentences.splice(idx, 1);
    config.systemPrompt = sentences.join(" ");
  }

}
