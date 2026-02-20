import { describe, it, expect } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { Brain, type BrainResponse, type ChatParams } from "../../src/brain/index.js";
import { Executor } from "../../src/executor/index.js";
import { OrganismStateManager } from "../../src/state/organism-state.js";
import { OrganismStateMachine } from "../../src/loop/state-machine.js";
import type { AgentEvent } from "../../src/types/index.js";

// Mock Brain that returns scripted responses
class MockBrain extends Brain {
  responses: BrainResponse[] = [];
  callIndex = 0;

  constructor() {
    super({});
  }

  addResponse(content: Anthropic.ContentBlock[], stopReason: BrainResponse["stopReason"] = "end_turn") {
    this.responses.push({
      content,
      stopReason,
      usage: { input: 100, output: 50, cacheCreation: 0, cacheRead: 0 },
    });
  }

  async chat(_params: ChatParams): Promise<BrainResponse> {
    const resp = this.responses[this.callIndex % this.responses.length];
    if (!resp) throw new Error("MockBrain: no responses configured");
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
    if (command.includes("manifest.json")) return "{}";
    if (command.includes("verify.sh")) return "PASS";
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

describe("OrganismStateMachine", () => {
  it("starts in forage mode", () => {
    const state = new OrganismStateManager({ budget: 50000 });
    expect(state.mode).toBe("forage");
    expect(state.alive).toBe(true);
  });

  it("organism dies at energy 0", async () => {
    const brain = new MockBrain();
    // Return end_turn immediately so the burst completes
    brain.addResponse(
      [{ type: "text", text: "Done.", citations: null }] as Anthropic.ContentBlock[],
      "end_turn",
    );

    const executor = new MockExecutor();
    const state = new OrganismStateManager({ budget: 10, reserves: 10 });

    const machine = new OrganismStateMachine(
      brain,
      executor as unknown as Executor,
      state,
      "/tmp/test-organism.json",
    );

    const events = await collectEvents(machine.run());
    expect(state.alive).toBe(false);
    expect(events.some((e) => e.type === "state_change" && (e as any).to === "dead")).toBe(true);
  });

  it("transition tool switches mode", async () => {
    const brain = new MockBrain();
    // First call: forage calls transition("think")
    brain.addResponse(
      [
        {
          type: "tool_use",
          id: "toolu_t1",
          name: "transition",
          input: { mode: "think" },
        },
      ] as Anthropic.ContentBlock[],
      "tool_use",
    );
    // Think response (single call)
    brain.addResponse(
      [{ type: "text", text: "Plan: do stuff", citations: null }] as Anthropic.ContentBlock[],
      "end_turn",
    );
    // Back to forage
    brain.addResponse(
      [{ type: "text", text: "Following plan.", citations: null }] as Anthropic.ContentBlock[],
      "end_turn",
    );
    // Resolve calls (multiple)
    brain.addResponse(
      [{ type: "text", text: '{"outcome":"success","lesson":"test","goalRelevance":0.5,"goalComplete":false}', citations: null }] as Anthropic.ContentBlock[],
      "end_turn",
    );
    // Memorize calls
    brain.addResponse(
      [{ type: "text", text: '{}', citations: null }] as Anthropic.ContentBlock[],
      "end_turn",
    );

    const executor = new MockExecutor();
    const state = new OrganismStateManager({ budget: 100000 });

    const machine = new OrganismStateMachine(
      brain,
      executor as unknown as Executor,
      state,
      "/tmp/test-organism.json",
    );

    const events = await collectEvents(machine.run(), 30);
    const stateChanges = events.filter((e) => e.type === "state_change");
    // Should have forage->forage, then forage->think, then back
    expect(stateChanges.some((e) => (e as any).to === "think")).toBe(true);
  });
});
