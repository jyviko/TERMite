import { describe, it, expect } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import type { LLMResponse, ChatParams } from "../../src/llm/index.js";
import { LLM } from "../../src/llm/index.js";
import { AgenticLoop } from "../../src/loop/agentic-loop.js";
import type { AgentEvent } from "../../src/types/index.js";

class MockLLM extends LLM {
  responses: LLMResponse[];
  callIndex = 0;
  calls: ChatParams[] = [];

  constructor(responses: LLMResponse[]) {
    super({});
    this.responses = responses;
  }

  async chat(params: ChatParams): Promise<LLMResponse> {
    // Snapshot messages so mutations after the call don't affect our record
    this.calls.push({ ...params, messages: [...params.messages] });
    const resp = this.responses[this.callIndex];
    if (!resp) throw new Error("MockLLM: no more responses");
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
    const llm = new MockLLM([
      {
        content: [{ type: "text", text: "Done.", citations: null }] as Anthropic.ContentBlock[],
        stopReason: "end_turn",
        usage: { input: 50, output: 10, cacheCreation: 0, cacheRead: 0 },
      },
    ]);

    const loop = new AgenticLoop(llm);
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

    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe("usage");
    expect(events[1]!.type).toBe("text");
  });

  it("loops with tool calls and results", async () => {
    const llm = new MockLLM([
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
        usage: { input: 100, output: 30, cacheCreation: 0, cacheRead: 0 },
      },
      {
        content: [{ type: "text", text: "Done.", citations: null }] as Anthropic.ContentBlock[],
        stopReason: "end_turn",
        usage: { input: 150, output: 20, cacheCreation: 0, cacheRead: 0 },
      },
    ]);

    const loop = new AgenticLoop(llm);
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
    const llm = new MockLLM([
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
        usage: { input: 100, output: 30, cacheCreation: 0, cacheRead: 0 },
      },
      {
        content: [{ type: "text", text: "Done.", citations: null }] as Anthropic.ContentBlock[],
        stopReason: "end_turn",
        usage: { input: 200, output: 10, cacheCreation: 0, cacheRead: 0 },
      },
    ]);

    const loop = new AgenticLoop(llm);
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
    const secondCallMessages = llm.calls[1]!.messages;
    const lastMsg = secondCallMessages[secondCallMessages.length - 1]!;
    expect(lastMsg.role).toBe("user");
    expect(Array.isArray(lastMsg.content)).toBe(true);
    const blocks = lastMsg.content as Anthropic.ContentBlockParam[];
    // 2 tool results + 1 usage note text block
    expect(blocks).toHaveLength(3);
    expect(blocks[0]!.type).toBe("tool_result");
    expect((blocks[0] as Anthropic.ToolResultBlockParam).tool_use_id).toBe("toolu_abc");
    expect((blocks[1] as Anthropic.ToolResultBlockParam).tool_use_id).toBe("toolu_def");
    expect(blocks[2]!.type).toBe("text"); // usage note
  });

  it("catches tool errors and returns them as results", async () => {
    const llm = new MockLLM([
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
        usage: { input: 100, output: 30, cacheCreation: 0, cacheRead: 0 },
      },
      {
        content: [{ type: "text", text: "Saw the error.", citations: null }] as Anthropic.ContentBlock[],
        stopReason: "end_turn",
        usage: { input: 200, output: 10, cacheCreation: 0, cacheRead: 0 },
      },
    ]);

    const loop = new AgenticLoop(llm);
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
    const endlessResponses: LLMResponse[] = Array.from({ length: 10 }, (_, i) => ({
      content: [
        {
          type: "tool_use" as const,
          id: `toolu_${i}`,
          name: "execute_shell",
          input: { command: "ls" },
        },
      ] as Anthropic.ContentBlock[],
      stopReason: "tool_use" as const,
      usage: { input: 50, output: 20, cacheCreation: 0, cacheRead: 0 },
    }));

    const llm = new MockLLM(endlessResponses);
    const loop = new AgenticLoop(llm);

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

    expect(llm.callIndex).toBe(3);
  });

  it("AbortSignal stops loop", async () => {
    const controller = new AbortController();

    const llm = new MockLLM([
      {
        content: [{ type: "text", text: "Start.", citations: null }] as Anthropic.ContentBlock[],
        stopReason: "end_turn",
        usage: { input: 50, output: 10, cacheCreation: 0, cacheRead: 0 },
      },
    ]);

    controller.abort();

    const loop = new AgenticLoop(llm);
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
    expect(llm.callIndex).toBe(0);
  });
});
