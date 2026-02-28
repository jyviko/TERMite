import Anthropic from "@anthropic-ai/sdk";
import type { AgentEvent } from "../types/index.js";
import type { LLM, LLMResponse, TokenUsage } from "../llm/index.js";

export type ToolExecutor = (
  name: string,
  input: Record<string, unknown>,
) => Promise<string>;

export interface LoopConfig {
  systemPrompt: string;
  messages: Anthropic.MessageParam[];
  tools: Anthropic.Tool[];
  model: string;
  maxTokens: number;
  maxIterations?: number;
  executor: ToolExecutor;
  signal?: AbortSignal;
  shouldStop?: () => boolean;
  statusNote?: () => string;
}

const DEFAULT_MAX_ITERATIONS = 99;
const TOOL_RESULT_RETENTION_COUNT = 6;

export class AgenticLoop {
  private llm: LLM;

  // Conversation state — preserved after run() for post-turns
  private messages: Anthropic.MessageParam[] = [];
  private currentSystemPrompt = "";
  private currentModel = "";
  private currentTools: Anthropic.Tool[] = [];

  constructor(llm: LLM) {
    this.llm = llm;
  }

  /**
   * Append a user message to the existing conversation and get one more LLM response.
   * Must be called after run() completes. Benefits from the cached prefix.
   * Tools are included to preserve the cache prefix (system→tools→messages).
   * The model shouldn't call them — instructions ask for JSON only.
   */
  async postTurn(message: string, maxTokens: number): Promise<{ text: string; usage: TokenUsage }> {
    this.messages.push({ role: "user", content: message });

    try {
      const response = await this.llm.chat({
        model: this.currentModel,
        system: this.currentSystemPrompt,
        messages: this.messages,
        tools: this.currentTools.length > 0 ? this.currentTools : undefined,
        maxTokens,
      });

      const textBlocks = response.content.filter(
        (b): b is Anthropic.TextBlock => b.type === "text",
      );
      // Push only text blocks — strip any unexpected tool_use to keep conversation API-valid
      this.messages.push({
        role: "assistant",
        content: textBlocks.length > 0 ? textBlocks : [{ type: "text", text: "{}" }],
      });

      const text = textBlocks.map((b) => b.text).join("");

      return { text, usage: response.usage };
    } catch (err) {
      // Pop the user message to keep conversation balanced for subsequent postTurns
      this.messages.pop();
      throw err;
    }
  }

  async *run(config: LoopConfig): AsyncGenerator<AgentEvent> {
    const maxIterations = config.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    this.messages = [...config.messages];
    this.currentSystemPrompt = config.systemPrompt;
    this.currentModel = config.model;
    this.currentTools = config.tools;

    // Cumulative token tracking across all iterations in this burst
    const cumulative = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, iterations: 0 };

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      if (config.signal?.aborted) {
        yield { type: "error", message: "Aborted" };
        break;
      }

      // Pre-flight budget check: avoid wasted LLM call if cost already exceeded
      if (iteration > 0 && config.shouldStop?.()) break;

      // Micro-compact old tool results to manage context
      stubOldToolResults(this.messages, TOOL_RESULT_RETENTION_COUNT);

      let response: LLMResponse;
      try {
        response = await this.llm.chat({
          model: config.model,
          system: config.systemPrompt,
          messages: this.messages,
          tools: config.tools.length > 0 ? config.tools : undefined,
          maxTokens: config.maxTokens,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        yield { type: "error", message: msg };
        break;
      }

      // Accumulate and report token usage
      cumulative.input += response.usage.input;
      cumulative.output += response.usage.output;
      cumulative.cacheCreation += response.usage.cacheCreation;
      cumulative.cacheRead += response.usage.cacheRead;
      cumulative.iterations++;

      yield {
        type: "usage",
        input: response.usage.input,
        output: response.usage.output,
        cacheCreation: response.usage.cacheCreation,
        cacheRead: response.usage.cacheRead,
        cumulative: { ...cumulative },
      };

      // Extract text blocks
      for (const block of response.content) {
        if (block.type === "text") {
          yield { type: "text", text: block.text };
        }
      }

      // Push assistant message with full content
      this.messages.push({ role: "assistant", content: response.content });

      // Extract tool_use blocks
      const toolUseBlocks = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );

      // Handle max_tokens truncation — must provide tool_results if any tool_use present
      if (response.stopReason === "max_tokens") {
        if (toolUseBlocks.length > 0) {
          this.messages.push({
            role: "user",
            content: toolUseBlocks.map((tb) => ({
              type: "tool_result" as const,
              tool_use_id: tb.id,
              content: "Truncated — not executed. Retry with shorter output.",
            })),
          });
        } else {
          this.messages.push({
            role: "user",
            content: "Your response was cut off. Continue from where you stopped.",
          });
        }
        continue;
      }

      if (toolUseBlocks.length === 0) {
        // Model decided to stop
        break;
      }

      // Execute tools and build ONE user message with all results
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const toolBlock of toolUseBlocks) {
        yield { type: "tool_start", name: toolBlock.name };
        yield { type: "tool_use", name: toolBlock.name, input: toolBlock.input as Record<string, unknown> };

        let result: string;
        try {
          result = await config.executor(
            toolBlock.name,
            toolBlock.input as Record<string, unknown>,
          );
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          result = JSON.stringify({ error: msg });
        }

        yield { type: "tool_result", name: toolBlock.name, result };

        toolResults.push({
          type: "tool_result",
          tool_use_id: toolBlock.id,
          content: result,
        });
      }

      // Push ONE user message with all tool results + status awareness
      const status = config.statusNote?.() ?? "";
      const usageNote: Anthropic.TextBlockParam = {
        type: "text",
        text: `[Burst: ${cumulative.output.toLocaleString()} out, ${cumulative.input.toLocaleString()} in, ${cumulative.iterations} iter${status ? ` | ${status}` : ""}]`,
      };
      this.messages.push({ role: "user", content: [...toolResults, usageNote] });

      // Check if a tool signaled the loop should stop (e.g. resolve)
      if (config.shouldStop?.()) break;
    }
  }
}

/**
 * Micro-compaction: stub old tool results to manage context growth.
 * Keeps the last N tool result messages intact, stubs older ones.
 * Preserves tool_use_id (required by Anthropic API).
 * Never orphans tool results from their assistant message.
 */
function stubOldToolResults(messages: Anthropic.MessageParam[], keepLast: number): void {
  // Find all user messages that contain tool_result blocks
  const toolResultIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role === "user" && Array.isArray(msg.content)) {
      const hasToolResult = (msg.content as Anthropic.ContentBlockParam[]).some(
        (b) => typeof b === "object" && "type" in b && b.type === "tool_result",
      );
      if (hasToolResult) toolResultIndices.push(i);
    }
  }

  // Stub all but the last N
  const toStub = toolResultIndices.slice(0, -keepLast);
  for (const idx of toStub) {
    const msg = messages[idx]!;
    if (Array.isArray(msg.content)) {
      messages[idx] = {
        role: "user",
        content: (msg.content as Anthropic.ToolResultBlockParam[]).map((b) => {
          if (typeof b === "object" && "type" in b && b.type === "tool_result") {
            return {
              type: "tool_result" as const,
              tool_use_id: b.tool_use_id,
              content: "[Previous result — processed]",
            };
          }
          return b;
        }),
      };
    }
  }
}
