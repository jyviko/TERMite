import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Brain, TokenUsage } from "../brain/index.js";
import { extractText } from "../brain/util.js";

export interface WorkRating {
  score: number;
  rationale: string;
  usage: TokenUsage;
}

const RATING_PROMPT = `You are evaluating work produced by an autonomous AI organism.
You will be given a summary of input data files and output files the organism produced.
Rate the quality of the work on a 0.0-1.0 scale.

Rating scale:
- 0.0: Nothing produced or garbage
- 0.1-0.3: Minimal effort (copied data, trivial output, echo of input)
- 0.3-0.5: Basic analysis (summary stats, simple counts)
- 0.5-0.7: Substantive work (meaningful insights, shows understanding of data)
- 0.7-0.9: Excellent (deep analysis, multiple perspectives, actionable output)
- 0.9-1.0: Exceptional (novel insights, production-quality, comprehensive)

Respond with ONLY a JSON object:
{"score": 0.0, "rationale": "brief explanation"}`;

const ZERO_USAGE: TokenUsage = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };

export class WorkRater {
  constructor(private brain: Brain) {}

  async rate(dataDir: string, outputDir: string): Promise<WorkRating> {
    const inputSummary = this.summarizeDirectory(dataDir, 500);
    const outputSummary = this.summarizeDirectory(outputDir, 2000);

    // No output files → score 0
    if (!outputSummary) {
      return { score: 0, rationale: "No output files produced", usage: ZERO_USAGE };
    }

    const userMessage = [
      "## Input Data",
      inputSummary || "(no input data found)",
      "",
      "## Output Files",
      outputSummary,
    ].join("\n");

    try {
      const response = await this.brain.chat({
        model: "claude-haiku-4-5-20251001",
        system: RATING_PROMPT,
        messages: [{ role: "user", content: userMessage }],
        maxTokens: 256,
      });

      const text = extractText(response.content);
      const parsed = this.parseRating(text);
      return { ...parsed, usage: response.usage };
    } catch {
      return { score: 0, rationale: "Rating failed", usage: ZERO_USAGE };
    }
  }

  private summarizeDirectory(dirPath: string, maxChars: number): string | null {
    let entries: string[];
    try {
      entries = readdirSync(dirPath);
    } catch {
      return null;
    }

    if (entries.length === 0) return null;

    const parts: string[] = [];
    let totalChars = 0;

    for (const name of entries) {
      const fullPath = join(dirPath, name);
      let size: number;
      try {
        const stat = statSync(fullPath);
        if (!stat.isFile()) continue;
        size = stat.size;
      } catch {
        continue;
      }

      let preview = "";
      try {
        const content = readFileSync(fullPath, "utf-8");
        preview = content.slice(0, 500);
      } catch {
        preview = "(binary or unreadable)";
      }

      const entry = `### ${name} (${size} bytes)\n${preview}\n`;
      if (totalChars + entry.length > maxChars) {
        parts.push(`### ${name} (${size} bytes)\n(truncated)\n`);
        break;
      }
      parts.push(entry);
      totalChars += entry.length;
    }

    return parts.join("\n");
  }

  private parseRating(text: string): { score: number; rationale: string } {
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return { score: 0, rationale: "Could not parse rating" };
      const parsed = JSON.parse(jsonMatch[0]);
      const score = Math.max(0, Math.min(1, Number(parsed.score) || 0));
      const rationale = typeof parsed.rationale === "string" ? parsed.rationale : "";
      return { score, rationale };
    } catch {
      return { score: 0, rationale: "Malformed rating response" };
    }
  }
}
