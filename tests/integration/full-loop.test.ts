import { describe, it, expect } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { Brain, type BrainResponse, type ChatParams } from "../../src/brain/index.js";
import { Executor } from "../../src/executor/index.js";
import { OrganismStateManager } from "../../src/state/organism-state.js";
import { OrganismStateMachine } from "../../src/loop/state-machine.js";
import type { AgentEvent } from "../../src/types/index.js";

class ScriptedBrain extends Brain {
  private script: BrainResponse[];
  private idx = 0;

  constructor(script: BrainResponse[]) {
    super({});
    this.script = script;
  }

  async chat(_params: ChatParams): Promise<BrainResponse> {
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
    if (command.includes("ls")) return "quests/ output/ skills/";
    if (command.includes("quest.json")) {
      return JSON.stringify({
        id: "q1", tier: 1, title: "Hello",
        description: "Write Hello, World!",
        reward: 2000,
      });
    }
    if (command.includes("manifest.json")) return "{}";
    if (command.includes("verify.sh")) {
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
  it("organism forage → explore → solve quest → earn energy", async () => {
    const brain = new ScriptedBrain([
      // Forage burst 1: explore workspace
      {
        content: [
          { type: "text", text: "Exploring workspace.", citations: null },
          { type: "tool_use", id: "t1", name: "execute_shell", input: { command: "ls /workspace/" } },
        ] as Anthropic.ContentBlock[],
        stopReason: "tool_use",
        usage: { input: 200, output: 50, cacheCreation: 0, cacheRead: 0 },
      },
      // See quest, read it
      {
        content: [
          { type: "tool_use", id: "t2", name: "execute_shell", input: { command: "cat /workspace/quests/quest.json" } },
        ] as Anthropic.ContentBlock[],
        stopReason: "tool_use",
        usage: { input: 300, output: 40, cacheCreation: 0, cacheRead: 0 },
      },
      // Write solution
      {
        content: [
          { type: "text", text: "Writing solution.", citations: null },
          { type: "tool_use", id: "t3", name: "write_file", input: { path: "output/greeting.txt", content: "Hello, World!" } },
        ] as Anthropic.ContentBlock[],
        stopReason: "tool_use",
        usage: { input: 350, output: 60, cacheCreation: 0, cacheRead: 0 },
      },
      // Verify
      {
        content: [
          { type: "tool_use", id: "t4", name: "check_quest", input: {} },
        ] as Anthropic.ContentBlock[],
        stopReason: "tool_use",
        usage: { input: 400, output: 30, cacheCreation: 0, cacheRead: 0 },
      },
      // Done foraging
      {
        content: [
          { type: "text", text: "Quest complete!", citations: null },
        ] as Anthropic.ContentBlock[],
        stopReason: "end_turn",
        usage: { input: 450, output: 20, cacheCreation: 0, cacheRead: 0 },
      },
      // Resolve response
      {
        content: [
          { type: "text", text: '{"outcome":"success","lesson":"Read quest first","goalRelevance":0.9,"goalComplete":true}', citations: null },
        ] as Anthropic.ContentBlock[],
        stopReason: "end_turn",
        usage: { input: 200, output: 50, cacheCreation: 0, cacheRead: 0 },
      },
      // Memorize response
      {
        content: [
          { type: "text", text: '{"store":[{"content":"Always read quest.json first","type":"procedural","importance":0.8}]}', citations: null },
        ] as Anthropic.ContentBlock[],
        stopReason: "end_turn",
        usage: { input: 200, output: 40, cacheCreation: 0, cacheRead: 0 },
      },
    ]);

    const executor = new MockExecutor();
    const state = new OrganismStateManager({ budget: 100000 });

    const machine = new OrganismStateMachine(
      brain,
      executor as unknown as Executor,
      state,
      "/tmp/test-integration.json",
    );

    const events: AgentEvent[] = [];
    let count = 0;
    for await (const event of machine.run()) {
      events.push(event);
      count++;
      if (count > 40) break; // Safety limit
    }

    // Verify energy was consumed
    expect(state.energy.spent).toBeGreaterThan(0);

    // Verify cycle progressed
    expect(state.cycleCount).toBeGreaterThanOrEqual(1);

    // Verify events include tool interactions
    expect(events.some((e) => e.type === "tool_start")).toBe(true);
    expect(events.some((e) => e.type === "tool_result")).toBe(true);
  });
});
