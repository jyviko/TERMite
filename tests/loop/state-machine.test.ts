import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { LLM, type LLMResponse, type ChatParams } from "../../src/llm/index.js";
import { Executor } from "../../src/executor/index.js";
import { AgentStateManager } from "../../src/state/agent-state.js";
import { AgentStateMachine } from "../../src/loop/state-machine.js";
import { TEQPool } from "../../src/arena/teq-pool.js";
import type { AgentEvent } from "../../src/types/index.js";

// Mock LLM that returns scripted responses
class MockLLM extends LLM {
  responses: LLMResponse[] = [];
  callIndex = 0;

  constructor() {
    super({});
  }

  addResponse(content: Anthropic.ContentBlock[], stopReason: LLMResponse["stopReason"] = "end_turn") {
    this.responses.push({
      content,
      stopReason,
      usage: { input: 100, output: 50, cacheCreation: 0, cacheRead: 0 },
    });
  }

  async chat(_params: ChatParams): Promise<LLMResponse> {
    const resp = this.responses[this.callIndex % this.responses.length];
    if (!resp) throw new Error("MockLLM: no responses configured");
    this.callIndex++;
    return resp;
  }
}

// Mock Executor (no Docker)
class MockExecutor {
  private workingDir_ = "/workspace";

  get workingDir(): string {
    return this.workingDir_;
  }

  get containerName(): string {
    return "mock-container";
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async executeShell(command: string): Promise<string> {
    if (command.includes("find /workspace/tools")) {
      return "/workspace/tools/shell\n/workspace/tools/check";
    }
    if (command.startsWith("/workspace/tools/check")) return "PASS";
    return `(mock) ${command}`;
  }

  async writeFile(_path: string, _content: string): Promise<string> {
    return "wrote /workspace/test.txt";
  }
}

async function collectEvents(gen: AsyncGenerator<AgentEvent>, maxEvents = 50): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const e of gen) {
    events.push(e);
    if (events.length >= maxEvents) break;
  }
  return events;
}

describe("AgentStateMachine", () => {
  let pool: TEQPool;

  beforeEach(() => {
    TEQPool.reset();
    pool = TEQPool.initialize({ initialBalance: 10_000_000 });
  });

  afterEach(() => {
    TEQPool.reset();
  });

  it("starts in alive mode", () => {
    const state = new AgentStateManager({ budget: 50000 });
    expect(state.mode).toBe("alive");
    expect(state.alive).toBe(true);
  });

  it("Agent dies at energy 0", async () => {
    const llm = new MockLLM();
    // Return end_turn immediately so cycle completes
    llm.addResponse(
      [{ type: "text", text: "Done.", citations: null }] as Anthropic.ContentBlock[],
      "end_turn",
    );

    const executor = new MockExecutor();
    const state = new AgentStateManager({ budget: 10, reserves: 10 });

    const machine = new AgentStateMachine(
      llm,
      executor as unknown as Executor,
      state,
      pool,
      "/tmp/test-Agent.json",
    );

    const events = await collectEvents(machine.run());
    expect(state.alive).toBe(false);
    expect(events.some((e) => e.type === "state_change" && (e as any).to === "dead")).toBe(true);
  });

  it("internal resolve tool triggers income computation", async () => {
    const llm = new MockLLM();
    // Call resolve tool
    llm.addResponse(
      [
        {
          type: "tool_use",
          id: "toolu_r1",
          name: "resolve",
          input: { input: "I explored the workspace" },
        },
      ] as Anthropic.ContentBlock[],
      "tool_use",
    );
    // Resolve LLM response (from Resolver)
    llm.addResponse(
      [{ type: "text", text: '{"outcome":"success","lesson":"Good work","goalRelevance":0.8,"goalComplete":false}', citations: null }] as Anthropic.ContentBlock[],
      "end_turn",
    );
    // After resolve, call memorize to end cycle
    llm.addResponse(
      [
        {
          type: "tool_use",
          id: "toolu_m1",
          name: "memorize",
          input: { input: "resolved successfully" },
        },
      ] as Anthropic.ContentBlock[],
      "tool_use",
    );

    const executor = new MockExecutor();
    const state = new AgentStateManager({ budget: 100000 });

    const machine = new AgentStateMachine(
      llm,
      executor as unknown as Executor,
      state,
      pool,
      "/tmp/test-resolve.json",
    );

    const events = await collectEvents(machine.run(), 20);
    const resolveResult = events.find(
      (e) => e.type === "tool_result" && (e as any).name === "resolve",
    );
    expect(resolveResult).toBeDefined();
    // Result should contain earnings, cost transparency, and outcome
    expect((resolveResult as any).result).toContain("earned");
    expect((resolveResult as any).result).toContain("resolve cost");
    expect((resolveResult as any).result).toContain("net");
    expect((resolveResult as any).result).toContain("outcome: success");
  });

  it("internal memorize tool stores memory via JSON operations", async () => {
    const llm = new MockLLM();
    // Call memorize tool with full JSON operations — memorize ends the cycle
    llm.addResponse(
      [
        {
          type: "tool_use",
          id: "toolu_m1",
          name: "memorize",
          input: { session: { store: [{ content: "Always check data directory first", type: "procedural", importance: 0.9 }] } },
        },
      ] as Anthropic.ContentBlock[],
      "tool_use",
    );

    const executor = new MockExecutor();
    const state = new AgentStateManager({ budget: 100000 });

    const machine = new AgentStateMachine(
      llm,
      executor as unknown as Executor,
      state,
      pool,
      "/tmp/test-memorize.json",
    );

    const events = await collectEvents(machine.run(), 20);
    const memResult = events.find(
      (e) => e.type === "tool_result" && (e as any).name === "memorize",
    );
    expect(memResult).toBeDefined();
    expect((memResult as any).result).toContain("stored");
    expect((memResult as any).result).toContain("procedural");
    expect((memResult as any).result).toContain("context reset");
    // Verify the memory was actually stored
    expect(state.memories.memories.length).toBeGreaterThan(0);
    expect(state.memories.memories[0]!.content).toBe("Always check data directory first");
    expect(state.memories.memories[0]!.importance).toBe(0.9);
  });

  it("memorize tool accepts plain text as semantic memory", async () => {
    const llm = new MockLLM();
    // Call memorize with plain text (no JSON) — memorize ends cycle
    llm.addResponse(
      [
        {
          type: "tool_use",
          id: "toolu_pt",
          name: "memorize",
          input: { input: "Check data directory has numbers.txt before processing" },
        },
      ] as Anthropic.ContentBlock[],
      "tool_use",
    );

    const executor = new MockExecutor();
    const state = new AgentStateManager({ budget: 100000 });

    const machine = new AgentStateMachine(
      llm,
      executor as unknown as Executor,
      state,
      pool,
      "/tmp/test-plaintext-memorize.json",
    );

    const events = await collectEvents(machine.run(), 20);
    const memResult = events.find(
      (e) => e.type === "tool_result" && (e as any).name === "memorize",
    );
    expect(memResult).toBeDefined();
    expect((memResult as any).result).toContain("stored");
    expect((memResult as any).result).toContain("semantic");
    expect((memResult as any).result).toContain("context reset");
    // Verify the memory was stored
    expect(state.memories.memories.length).toBeGreaterThan(0);
    expect(state.memories.memories[0]!.content).toBe("Check data directory has numbers.txt before processing");
    expect(state.memories.memories[0]!.type).toBe("semantic");
    expect(state.memories.memories[0]!.importance).toBe(0.5);
  });

  it("memorize tool supports self-rewrite", async () => {
    const llm = new MockLLM();
    // Call memorize with mutate operation — memorize ends cycle
    llm.addResponse(
      [
        {
          type: "tool_use",
          id: "toolu_mut",
          name: "memorize",
          input: { persistent: { rewrite: [{ target: "systemPrompt", newPrompt: "Optimize for tool usage over reasoning." }] } },
        },
      ] as Anthropic.ContentBlock[],
      "tool_use",
    );

    const executor = new MockExecutor();
    const state = new AgentStateManager({ budget: 100000 });
    const originalPrompt = state.config.systemPrompt;

    const machine = new AgentStateMachine(
      llm,
      executor as unknown as Executor,
      state,
      pool,
      "/tmp/test-mutate.json",
    );

    const events = await collectEvents(machine.run(), 20);
    const mutResult = events.find(
      (e) => e.type === "tool_result" && (e as any).name === "memorize",
    );
    expect(mutResult).toBeDefined();
    expect((mutResult as any).result).toContain("rewrote systemPrompt");
    expect(state.config.systemPrompt).toBe("Optimize for tool usage over reasoning.");
    expect(state.config.systemPrompt).not.toBe(originalPrompt);
    expect(state.config.version).toBeGreaterThanOrEqual(1);
  });

  it("multi-resolve keeps best outcome and max relevance", async () => {
    const llm = new MockLLM();
    // Both resolve calls in the same tool turn (batched)
    llm.addResponse(
      [
        {
          type: "tool_use",
          id: "toolu_r1",
          name: "resolve",
          input: { input: "first check" },
        },
        {
          type: "tool_use",
          id: "toolu_r2",
          name: "resolve",
          input: { input: "second check after more work" },
        },
      ] as Anthropic.ContentBlock[],
      "tool_use",
    );
    // Resolver returns failure with low relevance (for first resolve)
    llm.addResponse(
      [{ type: "text", text: '{"outcome":"failure","lesson":"bad","goalRelevance":0.2,"goalComplete":false}', citations: null }] as Anthropic.ContentBlock[],
      "end_turn",
    );
    // Resolver returns success with high relevance (for second resolve)
    llm.addResponse(
      [{ type: "text", text: '{"outcome":"success","lesson":"good","goalRelevance":0.9,"goalComplete":true}', citations: null }] as Anthropic.ContentBlock[],
      "end_turn",
    );
    // After resolves, call memorize to end cycle
    llm.addResponse(
      [
        {
          type: "tool_use",
          id: "toolu_m1",
          name: "memorize",
          input: { input: "resolved twice" },
        },
      ] as Anthropic.ContentBlock[],
      "tool_use",
    );

    const executor = new MockExecutor();
    const state = new AgentStateManager({ budget: 500_000 });

    const machine = new AgentStateMachine(
      llm,
      executor as unknown as Executor,
      state,
      pool,
      "/tmp/test-multi-resolve.json",
    );

    await collectEvents(machine.run(), 30);

    // Cycle history should record the best outcome (success) and max relevance (0.9)
    expect(state.energy.cycleHistory.length).toBeGreaterThan(0);
    const lastCycle = state.energy.cycleHistory[0]!;
    expect(lastCycle.outcome).toBe("success");
    expect(lastCycle.goalRelevance).toBe(0.9);
  });

  it("memorize ends the agentic loop — no further API calls after memorize", async () => {
    const llm = new MockLLM();
    // Turn 1: call resolve + memorize in same turn
    // Resolve no longer ends cycle, but memorize does
    llm.addResponse(
      [
        {
          type: "tool_use",
          id: "toolu_r1",
          name: "resolve",
          input: { input: "finished the task" },
        },
        {
          type: "tool_use",
          id: "toolu_m1",
          name: "memorize",
          input: { input: "task complete" },
        },
      ] as Anthropic.ContentBlock[],
      "tool_use",
    );
    // Resolver LLM response
    llm.addResponse(
      [{ type: "text", text: '{"outcome":"success","lesson":"good","goalRelevance":0.8,"goalComplete":true}', citations: null }] as Anthropic.ContentBlock[],
      "end_turn",
    );
    // This response should NEVER be reached in cycle 1 — if it is, the loop didn't stop
    llm.addResponse(
      [
        {
          type: "tool_use",
          id: "toolu_extra",
          name: "resolve",
          input: { input: "this should not happen" },
        },
      ] as Anthropic.ContentBlock[],
      "tool_use",
    );

    const executor = new MockExecutor();
    // Low budget: exactly enough for 1 cycle (BMR=50 + chat=350 + resolver=350 = 750).
    // Agent dies at start of cycle 2 (spent >= budget), so no further brain calls.
    const state = new AgentStateManager({ budget: 800, reserves: 800 });

    const machine = new AgentStateMachine(
      llm,
      executor as unknown as Executor,
      state,
      pool,
      "/tmp/test-memorize-stops.json",
    );

    const events = await collectEvents(machine.run(), 30);

    // Resolve tool should have been called exactly once (single cycle)
    const resolveResults = events.filter(
      (e) => e.type === "tool_result" && (e as any).name === "resolve",
    );
    expect(resolveResults).toHaveLength(1);

    // Memorize in the same turn should execute and end the cycle
    const memorizeResults = events.filter(
      (e) => e.type === "tool_result" && (e as any).name === "memorize",
    );
    expect(memorizeResults).toHaveLength(1);
    expect((memorizeResults[0] as any).result).toContain("context reset");

    // LLM should have been called exactly 2 times:
    // 1) the main cycle chat call that returned resolve+memorize
    // 2) the resolver's internal LLM call
    // If the loop continued within cycle 1, callIndex would be 3+
    expect(llm.callIndex).toBe(2);
  });

});
