import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { LLM, type LLMResponse, type ChatParams } from "../../src/llm/index.js";
import { Executor } from "../../src/executor/index.js";
import { OrganismStateManager } from "../../src/state/organism-state.js";
import { OrganismStateMachine } from "../../src/loop/state-machine.js";
import { TEQPool } from "../../src/arena/teq-pool.js";
import type { AgentEvent } from "../../src/types/index.js";

class ScriptedLLM extends LLM {
  private script: LLMResponse[];
  private idx = 0;

  constructor(script: LLMResponse[]) {
    super({});
    this.script = script;
  }

  async chat(_params: ChatParams): Promise<LLMResponse> {
    const resp = this.script[this.idx % this.script.length]!;
    this.idx++;
    return resp;
  }
}

class MockExecutor {
  private files = new Map<string, string>();

  get workingDir(): string { return "/workspace"; }
  get containerName(): string { return "mock"; }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async executeShell(command: string): Promise<string> {
    if (command.includes("find /workspace/tools")) {
      return "/workspace/tools/shell\n/workspace/tools/check";
    }
    if (command.startsWith("/workspace/tools/check")) {
      const greeting = this.files.get("/workspace/output/greeting.txt");
      if (greeting === "Hello, World!") return "PASS";
      return "FAIL";
    }
    return "";
  }

  async writeFile(path: string, content: string): Promise<string> {
    const fullPath = path.startsWith("/") ? path : `/workspace/${path}`;
    this.files.set(fullPath, content);
    return `wrote ${fullPath}`;
  }
}

describe("Full Loop Integration", () => {
  let pool: TEQPool;

  beforeEach(() => {
    TEQPool.reset();
    pool = TEQPool.initialize({ initialBalance: 10_000_000 });
  });

  afterEach(() => {
    TEQPool.reset();
  });

  it("organism explores → solves task → earns energy", async () => {
    const llm = new ScriptedLLM([
      // Explore workspace
      {
        content: [
          { type: "text", text: "Exploring workspace.", citations: null },
          { type: "tool_use", id: "t1", name: "shell", input: { input: "ls /workspace/" } },
        ] as Anthropic.ContentBlock[],
        stopReason: "tool_use",
        usage: { input: 200, output: 50, cacheCreation: 0, cacheRead: 0 },
      },
      // Look at data
      {
        content: [
          { type: "tool_use", id: "t2", name: "shell", input: { input: "ls /workspace/data/" } },
        ] as Anthropic.ContentBlock[],
        stopReason: "tool_use",
        usage: { input: 300, output: 40, cacheCreation: 0, cacheRead: 0 },
      },
      // Write solution
      {
        content: [
          { type: "text", text: "Writing solution.", citations: null },
          { type: "tool_use", id: "t3", name: "shell", input: { input: "echo 'Hello, World!' > /workspace/output/greeting.txt" } },
        ] as Anthropic.ContentBlock[],
        stopReason: "tool_use",
        usage: { input: 350, output: 60, cacheCreation: 0, cacheRead: 0 },
      },
      // Verify via check tool
      {
        content: [
          { type: "tool_use", id: "t4", name: "check", input: {} },
        ] as Anthropic.ContentBlock[],
        stopReason: "tool_use",
        usage: { input: 400, output: 30, cacheCreation: 0, cacheRead: 0 },
      },
      // Call resolve (internal tool) to evaluate work
      {
        content: [
          { type: "tool_use", id: "t5", name: "resolve", input: { input: "Completed greeting task" } },
        ] as Anthropic.ContentBlock[],
        stopReason: "tool_use",
        usage: { input: 450, output: 30, cacheCreation: 0, cacheRead: 0 },
      },
      // Resolver LLM response
      {
        content: [
          { type: "text", text: '{"outcome":"success","lesson":"Check data first","goalRelevance":0.9,"goalComplete":true}', citations: null },
        ] as Anthropic.ContentBlock[],
        stopReason: "end_turn",
        usage: { input: 200, output: 50, cacheCreation: 0, cacheRead: 0 },
      },
      // Call memorize (internal tool) — memorize ends the cycle (context resets)
      {
        content: [
          { type: "tool_use", id: "t6", name: "memorize", input: { epigenetic: { store: [{ content: "Check data directory first", type: "procedural", importance: 0.8 }] } } },
        ] as Anthropic.ContentBlock[],
        stopReason: "tool_use",
        usage: { input: 500, output: 30, cacheCreation: 0, cacheRead: 0 },
      },
    ]);

    const executor = new MockExecutor();
    const state = new OrganismStateManager({ budget: 100000 });

    const machine = new OrganismStateMachine(
      llm,
      executor as unknown as Executor,
      state,
      pool,
      "/tmp/test-integration.json",
    );

    const events: AgentEvent[] = [];
    let count = 0;
    for await (const event of machine.run()) {
      events.push(event);
      count++;
      if (count > 60) break; // Safety limit
    }

    // Verify energy was consumed
    expect(state.energy.spent).toBeGreaterThan(0);

    // Verify cycle progressed
    expect(state.cycleCount).toBeGreaterThanOrEqual(1);

    // Verify events include tool interactions
    expect(events.some((e) => e.type === "tool_start")).toBe(true);
    expect(events.some((e) => e.type === "tool_result")).toBe(true);

    // Verify internal tools were used
    const resolveResults = events.filter(
      (e) => e.type === "tool_result" && (e as any).name === "resolve",
    );
    expect(resolveResults.length).toBeGreaterThan(0);

    // Verify memory was stored via memorize tool
    expect(state.memories.memories.length).toBeGreaterThan(0);
  });
});
