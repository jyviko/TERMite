import { describe, it, expect } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import type { BrainResponse, ChatParams } from "../../src/brain/index.js";
import { Brain } from "../../src/brain/index.js";
import { AgenticLoop } from "../../src/loop/agentic-loop.js";
import type { AgentEvent } from "../../src/types/index.js";

class MockBrain extends Brain {
  responses: BrainResponse[];
  callIndex = 0;
  calls: ChatParams[] = [];

  constructor(responses: BrainResponse[]) {
    super({});
    this.responses = responses;
  }

  async chat(params: ChatParams): Promise<BrainResponse> {
    // Snapshot messages so mutations after the call don't affect our record
    this.calls.push({ ...params, messages: [...params.messages] });
    const resp = this.responses[this.callIndex];
    if (!resp) throw new Error("MockBrain: no more responses");
    this.callIndex++;
    return resp;
  }
}

async function collectEvents(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

describe("AgenticLoop", () => {
  it("stops when model returns no tool calls", async () => {
    const brain = new MockBrain([
      {
        content: [{ type: "text", text: "Done.", citations: null }] as Anthropic.ContentBlock[],
        stopReason: "end_turn",
        usage: { input: 50, output: 10 },
      },
    ]);

    const loop = new AgenticLoop(brain);
    const events = await collectEvents(
      loop.run({
        systemPrompt: "test",
        messages: [{ role: "user", content: "hello" }],
        tools: [],
        model: "test",
        maxTokens: 100,
        executor: async () => "",
      }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("text");
  });

  it("loops with tool calls and results", async () => {
    const brain = new MockBrain([
      {
        content: [
          { type: "text", text: "Calling tool.", citations: null },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "execute_shell",
            input: { command: "ls" },
          },
        ] as Anthropic.ContentBlock[],
        stopReason: "tool_use",
        usage: { input: 100, output: 30 },
      },
      {
        content: [{ type: "text", text: "Done.", citations: null }] as Anthropic.ContentBlock[],
        stopReason: "end_turn",
        usage: { input: 150, output: 20 },
      },
    ]);

    const loop = new AgenticLoop(brain);
    const events = await collectEvents(
      loop.run({
        systemPrompt: "test",
        messages: [{ role: "user", content: "hello" }],
        tools: [
          {
            name: "execute_shell",
            description: "run shell",
            input_schema: { type: "object" as const, properties: {} },
          },
        ],
        model: "test",
        maxTokens: 100,
        executor: async (name: string) => {
          if (name === "execute_shell") return "file1.txt";
          return "";
        },
      }),
    );

    const types = events.map((e) => e.type);
    expect(types).toContain("text");
    expect(types).toContain("tool_start");
    expect(types).toContain("tool_result");
  });

  it("tool results assembled as ONE user message with correct tool_use_id", async () => {
    const brain = new MockBrain([
      {
        content: [
          {
            type: "tool_use",
            id: "toolu_abc",
            name: "execute_shell",
            input: { command: "ls" },
          },
          {
            type: "tool_use",
            id: "toolu_def",
            name: "execute_shell",
            input: { command: "pwd" },
          },
        ] as Anthropic.ContentBlock[],
        stopReason: "tool_use",
        usage: { input: 100, output: 30 },
      },
      {
        content: [{ type: "text", text: "Done.", citations: null }] as Anthropic.ContentBlock[],
        stopReason: "end_turn",
        usage: { input: 200, output: 10 },
      },
    ]);

    const loop = new AgenticLoop(brain);
    await collectEvents(
      loop.run({
        systemPrompt: "test",
        messages: [{ role: "user", content: "go" }],
        tools: [
          {
            name: "execute_shell",
            description: "run shell",
            input_schema: { type: "object" as const, properties: {} },
          },
        ],
        model: "test",
        maxTokens: 100,
        executor: async () => "result",
      }),
    );

    // Check second call's messages — should have tool results as user message
    const secondCallMessages = brain.calls[1]!.messages;
    const lastMsg = secondCallMessages[secondCallMessages.length - 1]!;
    expect(lastMsg.role).toBe("user");
    expect(Array.isArray(lastMsg.content)).toBe(true);
    const blocks = lastMsg.content as Anthropic.ToolResultBlockParam[];
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.type).toBe("tool_result");
    expect(blocks[0]!.tool_use_id).toBe("toolu_abc");
    expect(blocks[1]!.tool_use_id).toBe("toolu_def");
  });

  it("catches tool errors and returns them as results", async () => {
    const brain = new MockBrain([
      {
        content: [
          {
            type: "tool_use",
            id: "toolu_err",
            name: "execute_shell",
            input: { command: "bad" },
          },
        ] as Anthropic.ContentBlock[],
        stopReason: "tool_use",
        usage: { input: 100, output: 30 },
      },
      {
        content: [{ type: "text", text: "Saw the error.", citations: null }] as Anthropic.ContentBlock[],
        stopReason: "end_turn",
        usage: { input: 200, output: 10 },
      },
    ]);

    const loop = new AgenticLoop(brain);
    const events = await collectEvents(
      loop.run({
        systemPrompt: "test",
        messages: [{ role: "user", content: "go" }],
        tools: [
          {
            name: "execute_shell",
            description: "shell",
            input_schema: { type: "object" as const, properties: {} },
          },
        ],
        model: "test",
        maxTokens: 100,
        executor: async () => {
          throw new Error("command failed");
        },
      }),
    );

    const resultEvent = events.find(
      (e) => e.type === "tool_result",
    ) as Extract<AgentEvent, { type: "tool_result" }>;
    expect(resultEvent).toBeDefined();
    expect(resultEvent.result).toContain("command failed");
  });

  it("respects maxIterations", async () => {
    const endlessResponses: BrainResponse[] = Array.from({ length: 10 }, (_, i) => ({
      content: [
        {
          type: "tool_use" as const,
          id: `toolu_${i}`,
          name: "execute_shell",
          input: { command: "ls" },
        },
      ] as Anthropic.ContentBlock[],
      stopReason: "tool_use" as const,
      usage: { input: 50, output: 20 },
    }));

    const brain = new MockBrain(endlessResponses);
    const loop = new AgenticLoop(brain);

    const events = await collectEvents(
      loop.run({
        systemPrompt: "test",
        messages: [{ role: "user", content: "go" }],
        tools: [
          {
            name: "execute_shell",
            description: "shell",
            input_schema: { type: "object" as const, properties: {} },
          },
        ],
        model: "test",
        maxTokens: 100,
        maxIterations: 3,
        executor: async () => "ok",
      }),
    );

    expect(brain.callIndex).toBe(3);
  });

  it("AbortSignal stops loop", async () => {
    const controller = new AbortController();

    const brain = new MockBrain([
      {
        content: [{ type: "text", text: "Start.", citations: null }] as Anthropic.ContentBlock[],
        stopReason: "end_turn",
        usage: { input: 50, output: 10 },
      },
    ]);

    controller.abort();

    const loop = new AgenticLoop(brain);
    const events = await collectEvents(
      loop.run({
        systemPrompt: "test",
        messages: [{ role: "user", content: "go" }],
        tools: [],
        model: "test",
        maxTokens: 100,
        executor: async () => "",
        signal: controller.signal,
      }),
    );

    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(brain.callIndex).toBe(0);
  });
});
