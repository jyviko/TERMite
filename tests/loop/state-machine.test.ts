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
      return "shell|shell - Run a shell command\ncheck|check - Validate task output";
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

  it("starts in active mode", () => {
    const state = new AgentStateManager({ budget: 50000 });
    expect(state.mode).toBe("active");
    expect(state.active).toBe(true);
  });

  it("agent stops at energy 0", async () => {
    const llm = new MockLLM();
    // Think+Execute: end turn immediately
    llm.addResponse(
      [{ type: "text", text: "Done.", citations: null }] as Anthropic.ContentBlock[],
      "end_turn",
    );
    // Resolve phase LLM response
    llm.addResponse(
      [{ type: "text", text: '{"outcome":"uncertain","value":0,"energyJustified":false,"lesson":"no energy","goalComplete":false}', citations: null }] as Anthropic.ContentBlock[],
      "end_turn",
    );
    // Memorize phase LLM response
    llm.addResponse(
      [{ type: "text", text: '{}', citations: null }] as Anthropic.ContentBlock[],
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
    expect(state.active).toBe(false);
    expect(events.some((e) => e.type === "state_change" && (e as any).to === "stopped")).toBe(true);
  });

  it("three-phase cycle: Think+Execute → Resolve → Memorize", async () => {
    const llm = new MockLLM();
    // Phase 1: Think+Execute — agent uses a tool then ends turn
    llm.addResponse(
      [
        {
          type: "tool_use",
          id: "toolu_s1",
          name: "shell",
          input: { input: "ls /workspace" },
        },
      ] as Anthropic.ContentBlock[],
      "tool_use",
    );
    llm.addResponse(
      [{ type: "text", text: "Found files.", citations: null }] as Anthropic.ContentBlock[],
      "end_turn",
    );
    // Phase 2: Resolve — mandatory judgment
    llm.addResponse(
      [{ type: "text", text: '{"outcome":"success","value":0.8,"energyJustified":true,"lesson":"Explored workspace","goalComplete":false}', citations: null }] as Anthropic.ContentBlock[],
      "end_turn",
    );
    // Phase 3: Memorize — mandatory memory management
    llm.addResponse(
      [{ type: "text", text: '{}', citations: null }] as Anthropic.ContentBlock[],
      "end_turn",
    );

    const executor = new MockExecutor();
    const state = new AgentStateManager({ budget: 500_000 });

    const machine = new AgentStateMachine(
      llm,
      executor as unknown as Executor,
      state,
      pool,
      "/tmp/test-three-phase.json",
    );

    const events = await collectEvents(machine.run(), 30);

    // Verify all three phases fired
    const phases = events
      .filter((e) => e.type === "phase_change")
      .map((e) => (e as any).phase);
    expect(phases).toContain("executing");
    expect(phases).toContain("resolving");
    expect(phases).toContain("memorizing");

    // Verify resolve recorded outcome in cycle history
    expect(state.energy.cycleHistory.length).toBeGreaterThan(0);
    expect(state.energy.cycleHistory[0]!.outcome).toBe("success");
    expect(state.energy.cycleHistory[0]!.goalRelevance).toBe(0.8);

    // Verify auto-stored cycle memory pair
    expect(state.memories.memories.length).toBeGreaterThan(0);
    const cycleMem = state.memories.memories[0]!;
    expect(cycleMem.context).toContain("Cycle 0");
    expect(cycleMem.content).toContain("Outcome: success");
    expect(cycleMem.content).toContain("Explored workspace");

    // First cycle: think(tool_use) + think(end_turn) + resolve + memorize = 4 calls minimum
    expect(llm.callIndex).toBeGreaterThanOrEqual(4);
  });

  it("no resolve/memorize tools in the tool list", async () => {
    const llm = new MockLLM();
    // End turn immediately
    llm.addResponse(
      [{ type: "text", text: "Done.", citations: null }] as Anthropic.ContentBlock[],
      "end_turn",
    );
    // Resolve
    llm.addResponse(
      [{ type: "text", text: '{"outcome":"uncertain","value":0,"energyJustified":false,"lesson":"","goalComplete":false}', citations: null }] as Anthropic.ContentBlock[],
      "end_turn",
    );
    // Memorize
    llm.addResponse(
      [{ type: "text", text: '{}', citations: null }] as Anthropic.ContentBlock[],
      "end_turn",
    );

    const executor = new MockExecutor();
    const state = new AgentStateManager({ budget: 500_000 });

    const machine = new AgentStateMachine(
      llm,
      executor as unknown as Executor,
      state,
      pool,
      "/tmp/test-no-internal-tools.json",
    );

    const events = await collectEvents(machine.run(), 20);

    // Find the tools_available event
    const toolsEvent = events.find((e) => e.type === "tools_available");
    expect(toolsEvent).toBeDefined();
    const toolNames = (toolsEvent as any).tools as string[];
    expect(toolNames).not.toContain("resolve");
    expect(toolNames).not.toContain("memorize");
  });

  it("awareness message contains energy, drives, cycle — memories are conversation pairs", async () => {
    const llm = new MockLLM();

    // Capture messages from the FIRST LLM call only (Think phase)
    let firstCallMessages: Anthropic.MessageParam[] | null = null;
    const origChat = llm.chat.bind(llm);
    llm.chat = async (params: ChatParams) => {
      if (!firstCallMessages) firstCallMessages = params.messages;
      return origChat(params);
    };

    // End turn immediately
    llm.addResponse(
      [{ type: "text", text: "Done.", citations: null }] as Anthropic.ContentBlock[],
      "end_turn",
    );
    // Resolve
    llm.addResponse(
      [{ type: "text", text: '{"outcome":"uncertain","value":0,"energyJustified":false,"lesson":"","goalComplete":false}', citations: null }] as Anthropic.ContentBlock[],
      "end_turn",
    );
    // Memorize
    llm.addResponse(
      [{ type: "text", text: '{}', citations: null }] as Anthropic.ContentBlock[],
      "end_turn",
    );

    const executor = new MockExecutor();
    const state = new AgentStateManager({ budget: 500_000 });

    const machine = new AgentStateMachine(
      llm,
      executor as unknown as Executor,
      state,
      pool,
      "/tmp/test-awareness.json",
    );

    await collectEvents(machine.run(), 20);

    expect(firstCallMessages).not.toBeNull();
    expect(firstCallMessages!.length).toBeGreaterThan(0);

    // First cycle has no memories — only the awareness user message
    // Find the user message (withMessageCacheBreakpoint may wrap content)
    const userMessages = firstCallMessages!.filter((m) => m.role === "user");
    expect(userMessages.length).toBeGreaterThan(0);
    const awareness = userMessages[0]!;
    const text = typeof awareness.content === "string"
      ? awareness.content
      : (awareness.content as any[]).map((b: any) => b.text ?? "").join("");

    // Should contain status sections
    expect(text).toContain("Energy:");
    expect(text).toContain("Drives:");
    expect(text).toContain("Tools:");
    expect(text).toContain("Cycle:");

    // Memories are NOT in awareness text — they're injected as conversation pairs
    expect(text).not.toContain("Memories:");
  });

  it("memorize phase supports prompt rewrite via promptRewrite field", async () => {
    const llm = new MockLLM();
    // Think+Execute: end turn immediately
    llm.addResponse(
      [{ type: "text", text: "Done.", citations: null }] as Anthropic.ContentBlock[],
      "end_turn",
    );
    // Resolve
    llm.addResponse(
      [{ type: "text", text: '{"outcome":"partial","value":0.5,"energyJustified":true,"lesson":"learned something","goalComplete":false}', citations: null }] as Anthropic.ContentBlock[],
      "end_turn",
    );
    // Memorize with prompt rewrite
    llm.addResponse(
      [{ type: "text", text: '{"promptRewrite":"Optimize for tool usage over reasoning."}', citations: null }] as Anthropic.ContentBlock[],
      "end_turn",
    );

    const executor = new MockExecutor();
    const state = new AgentStateManager({ budget: 500_000 });
    const originalPrompt = state.config.systemPrompt;

    const machine = new AgentStateMachine(
      llm,
      executor as unknown as Executor,
      state,
      pool,
      "/tmp/test-rewrite.json",
    );

    await collectEvents(machine.run(), 20);

    expect(state.config.systemPrompt).toBe("Optimize for tool usage over reasoning.");
    expect(state.config.systemPrompt).not.toBe(originalPrompt);
    expect(state.config.version).toBeGreaterThanOrEqual(1);
  });

  it("resolve income is credited based on outcome and relevance", async () => {
    const llm = new MockLLM();
    // Think+Execute
    llm.addResponse(
      [{ type: "text", text: "Explored.", citations: null }] as Anthropic.ContentBlock[],
      "end_turn",
    );
    // Resolve — success with high relevance
    llm.addResponse(
      [{ type: "text", text: '{"outcome":"success","value":0.9,"energyJustified":true,"lesson":"Good work","goalComplete":false}', citations: null }] as Anthropic.ContentBlock[],
      "end_turn",
    );
    // Memorize
    llm.addResponse(
      [{ type: "text", text: '{}', citations: null }] as Anthropic.ContentBlock[],
      "end_turn",
    );

    const executor = new MockExecutor();
    const state = new AgentStateManager({ budget: 500_000 });
    const initialEarned = state.energy.earned;

    const machine = new AgentStateMachine(
      llm,
      executor as unknown as Executor,
      state,
      pool,
      "/tmp/test-income.json",
    );

    await collectEvents(machine.run(), 20);

    // Success outcome + high relevance should yield income
    expect(state.energy.earned).toBeGreaterThan(initialEarned);
    expect(state.energy.cycleHistory[0]!.income).toBeGreaterThan(0);
  });
});
