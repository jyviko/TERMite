import { describe, it, expect } from "vitest";
import { WorkRater } from "../../src/arena/work-rater.js";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock LLM that returns controlled responses
function mockBrain(responseText: string) {
  return {
    chat: async () => ({
      content: [{ type: "text" as const, text: responseText }],
      stopReason: "end_turn" as const,
      usage: { input: 100, output: 50, cacheCreation: 0, cacheRead: 0 },
    }),
  } as unknown as import("../../src/llm/index.js").LLM;
}

describe("WorkRater", () => {
  let workspace: string;

  function setup() {
    workspace = join(tmpdir(), `termite-rater-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(workspace, "data"), { recursive: true });
    mkdirSync(join(workspace, "output"), { recursive: true });
  }

  function cleanup() {
    rmSync(workspace, { recursive: true, force: true });
  }

  it("returns score 0 for empty output directory", async () => {
    setup();
    writeFileSync(join(workspace, "data", "input.csv"), "a,b,c\n1,2,3\n");
    const rater = new WorkRater(mockBrain(""));
    const rating = await rater.rate(join(workspace, "data"), join(workspace, "output"));
    expect(rating.score).toBe(0);
    expect(rating.rationale).toContain("No output");
    cleanup();
  });

  it("parses valid rating JSON", async () => {
    setup();
    writeFileSync(join(workspace, "data", "input.csv"), "a,b,c\n1,2,3\n");
    writeFileSync(join(workspace, "output", "report.json"), '{"summary": "analysis"}');
    const brain = mockBrain('{"score": 0.75, "rationale": "Good analysis with insights"}');
    const rater = new WorkRater(brain);
    const rating = await rater.rate(join(workspace, "data"), join(workspace, "output"));
    expect(rating.score).toBe(0.75);
    expect(rating.rationale).toBe("Good analysis with insights");
    expect(rating.usage.input).toBe(100);
    cleanup();
  });

  it("handles malformed response gracefully", async () => {
    setup();
    writeFileSync(join(workspace, "data", "input.csv"), "data\n");
    writeFileSync(join(workspace, "output", "result.txt"), "some output");
    const brain = mockBrain("I cannot rate this properly, here is garbage");
    const rater = new WorkRater(brain);
    const rating = await rater.rate(join(workspace, "data"), join(workspace, "output"));
    expect(rating.score).toBe(0);
    expect(rating.rationale).toContain("parse");
    cleanup();
  });

  it("clamps score to 0-1 range", async () => {
    setup();
    writeFileSync(join(workspace, "data", "input.csv"), "data\n");
    writeFileSync(join(workspace, "output", "result.txt"), "output");
    const brain = mockBrain('{"score": 5.0, "rationale": "impossibly good"}');
    const rater = new WorkRater(brain);
    const rating = await rater.rate(join(workspace, "data"), join(workspace, "output"));
    expect(rating.score).toBe(1);
    cleanup();
  });

  it("returns score 0 when data directory missing", async () => {
    setup();
    writeFileSync(join(workspace, "output", "result.txt"), "output");
    const brain = mockBrain('{"score": 0.5, "rationale": "some work"}');
    const rater = new WorkRater(brain);
    const rating = await rater.rate(join(workspace, "nonexistent"), join(workspace, "output"));
    expect(rating.score).toBe(0.5);
    cleanup();
  });
});
