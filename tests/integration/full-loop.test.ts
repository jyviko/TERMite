import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { LLM, type LLMResponse, type ChatParams } from "../../src/llm/index.js";
import { Executor } from "../../src/executor/index.js";
import { AgentStateManager } from "../../src/state/agent-state.js";
import { AgentStateMachine } from "../../src/loop/state-machine.js";
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
      return "shell|shell - Run a shell command\ncheck|check - Probe the environment";
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

  it("Agent explores → resolve judges → memorize stores", async () => {
    const llm = new ScriptedLLM([
      // Think+Execute phase: explore workspace
      {
        content: [
          { type: "text", text: "Exploring workspace.", citations: null },
          { type: "tool_use", id: "t1", name: "shell", input: { input: "ls /workspace/" } },
        ] as Anthropic.ContentBlock[],
        stopReason: "tool_use",
        usage: { input: 200, output: 50, cacheCreation: 0, cacheRead: 0 },
      },
      // Think+Execute phase: check task
      {
        content: [
          { type: "tool_use", id: "t2", name: "check", input: {} },
        ] as Anthropic.ContentBlock[],
        stopReason: "tool_use",
        usage: { input: 300, output: 40, cacheCreation: 0, cacheRead: 0 },
      },
      // Think+Execute phase: end turn
      {
        content: [
          { type: "text", text: "Done exploring.", citations: null },
        ] as Anthropic.ContentBlock[],
        stopReason: "end_turn",
        usage: { input: 350, output: 30, cacheCreation: 0, cacheRead: 0 },
      },
      // Resolve phase: mandatory judgment
      {
        content: [
          { type: "text", text: '{"outcome":"success","value":0.9,"energyJustified":true,"lesson":"Check data first","goalComplete":false}', citations: null },
        ] as Anthropic.ContentBlock[],
        stopReason: "end_turn",
        usage: { input: 200, output: 50, cacheCreation: 0, cacheRead: 0 },
      },
      // Memorize phase: mandatory memory management
      {
        content: [
          { type: "text", text: '{"store":[{"content":"Check data directory first","type":"procedural","importance":0.8}]}', citations: null },
        ] as Anthropic.ContentBlock[],
        stopReason: "end_turn",
        usage: { input: 200, output: 40, cacheCreation: 0, cacheRead: 0 },
      },
    ]);

    const executor = new MockExecutor();
    const state = new AgentStateManager({ budget: 100000 });

    const machine = new AgentStateMachine(
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
      if (count > 60) break;
    }

    // Verify energy was consumed
    expect(state.energy.spent).toBeGreaterThan(0);

    // Verify cycle progressed
    expect(state.cycleCount).toBeGreaterThanOrEqual(1);

    // Verify events include tool interactions (from Think+Execute phase)
    expect(events.some((e) => e.type === "tool_start")).toBe(true);
    expect(events.some((e) => e.type === "tool_result")).toBe(true);

    // Verify three phases fired
    const phases = events
      .filter((e) => e.type === "phase_change")
      .map((e) => (e as any).phase);
    expect(phases).toContain("executing");
    expect(phases).toContain("resolving");
    expect(phases).toContain("memorizing");

    // Verify no resolve/memorize tool calls in the event stream (they're phases now)
    const resolveToolResults = events.filter(
      (e) => e.type === "tool_result" && (e as any).name === "resolve",
    );
    expect(resolveToolResults).toHaveLength(0);

    // Verify auto-stored cycle memory pair
    expect(state.memories.memories.length).toBeGreaterThan(0);
    const cycleMem = state.memories.memories[0]!;
    expect(cycleMem.context).toContain("Cycle 0");
    expect(cycleMem.content).toContain("Outcome: success");

    // Verify income was earned from successful resolve
    expect(state.energy.earned).toBeGreaterThan(0);
  });
});
