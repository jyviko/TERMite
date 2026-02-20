import type { TaskResult, Memory } from "../types/index.js";
import type { Brain } from "../brain/index.js";
import { extractText } from "../brain/util.js";
import { Genome } from "../state/genome.js";

export class GenomeEvolver {
  constructor(private brain: Brain) {}

  async evolve(params: {
    parentGenome: Genome;
    memories: Memory[];
    taskHistory: TaskResult[];
    generation: number;
  }): Promise<Genome> {
    const formattedMemories = params.memories
      .sort((a, b) => b.importance - a.importance)
      .slice(0, 20)
      .map((m) => `[${m.type}] (${m.importance.toFixed(1)}) ${m.content}`)
      .join("\n");

    const formattedTaskHistory = params.taskHistory
      .slice(-10)
      .map((q) => `tier ${q.tier}: ${q.passed ? "PASS" : "FAIL"} in ${q.cyclesTaken} cycles`)
      .join("\n");

    const prompt = `You are evolving an organism's genome for the next generation.

Current genome (generation ${params.generation}):
${params.parentGenome.systemPrompt}

Parent's key memories (sorted by importance):
${formattedMemories || "(none)"}

Task history:
${formattedTaskHistory || "(none)"}

Create an evolved system prompt for the child. The child should:
1. Inherit the parent's successful strategies
2. Start with better instincts than the parent had at birth
3. Know common pitfalls the parent discovered
4. Be concise — every token in the genome costs energy every cycle

Return JSON: { "systemPrompt": "..." }`;

    try {
      const response = await this.brain.chat({
        model: params.parentGenome.routing.deep.model, // Sonnet
        system: prompt,
        messages: [{ role: "user", content: "Evolve the genome." }],
        maxTokens: 2048,
      });

      const text = extractText(response.content);

      const parsed = parseEvolveResponse(text);

      const child = new Genome({
        ...params.parentGenome.toJSON(),
        systemPrompt: parsed.systemPrompt ?? params.parentGenome.systemPrompt,
        version: params.parentGenome.version + 1,
        promptHistory: [],
      });

      // Random mutations
      applyMutations(child);

      return child;
    } catch {
      // If evolution fails, child gets parent's genome with incremented version
      return new Genome({
        ...params.parentGenome.toJSON(),
        version: params.parentGenome.version + 1,
        promptHistory: [],
      });
    }
  }
}

function parseEvolveResponse(text: string): { systemPrompt?: string } {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return {};
    return JSON.parse(jsonMatch[0]);
  } catch {
    return {};
  }
}

function applyMutations(genome: Genome): void {
  const sentences = genome.systemPrompt.split(/(?<=\.)\s+/);

  // 10% chance: shuffle one sentence
  if (Math.random() < 0.1 && sentences.length > 2) {
    const idx = Math.floor(Math.random() * sentences.length);
    const newIdx = Math.floor(Math.random() * sentences.length);
    const [removed] = sentences.splice(idx, 1);
    sentences.splice(newIdx, 0, removed!);
    genome.systemPrompt = sentences.join(" ");
  }

  // 5% chance: remove shortest sentence
  if (Math.random() < 0.05 && sentences.length > 3) {
    const shortest = sentences.reduce((a, b) => (a.length < b.length ? a : b));
    const idx = sentences.indexOf(shortest);
    if (idx >= 0) sentences.splice(idx, 1);
    genome.systemPrompt = sentences.join(" ");
  }

}
