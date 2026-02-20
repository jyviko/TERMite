import Anthropic from "@anthropic-ai/sdk";
import type { AgentEvent } from "../types/index.js";
import type { Brain, BrainResponse } from "../brain/index.js";

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
}

const DEFAULT_MAX_ITERATIONS = 99;
const MICRO_COMPACT_KEEP_LAST = 6;

export class AgenticLoop {
  constructor(private brain: Brain) {}

  async *run(config: LoopConfig): AsyncGenerator<AgentEvent> {
    const maxIterations = config.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    const messages: Anthropic.MessageParam[] = [...config.messages];

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      if (config.signal?.aborted) {
        yield { type: "error", message: "Aborted" };
        break;
      }

      // Micro-compact old tool results to manage context
      microCompact(messages, MICRO_COMPACT_KEEP_LAST);

      let response: BrainResponse;
      try {
        response = await this.brain.chat({
          model: config.model,
          system: config.systemPrompt,
          messages,
          tools: config.tools.length > 0 ? config.tools : undefined,
          maxTokens: config.maxTokens,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        yield { type: "error", message: msg };
        break;
      }

      // Report token usage
      yield {
        type: "usage",
        input: response.usage.input,
        output: response.usage.output,
        cacheCreation: response.usage.cacheCreation,
        cacheRead: response.usage.cacheRead,
      };

      // Extract text blocks
      for (const block of response.content) {
        if (block.type === "text") {
          yield { type: "text", text: block.text };
        }
      }

      // Push assistant message with full content
      messages.push({ role: "assistant", content: response.content });

      // Extract tool_use blocks
      const toolUseBlocks = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );

      // Handle max_tokens truncation — must provide tool_results if any tool_use present
      if (response.stopReason === "max_tokens") {
        if (toolUseBlocks.length > 0) {
          messages.push({
            role: "user",
            content: toolUseBlocks.map((tb) => ({
              type: "tool_result" as const,
              tool_use_id: tb.id,
              content: "Truncated — not executed. Retry with shorter output.",
            })),
          });
        } else {
          messages.push({
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

      // Push ONE user message with all tool results
      messages.push({ role: "user", content: toolResults });
    }
  }
}

/**
 * Micro-compaction: stub old tool results to manage context growth.
 * Keeps the last N tool result messages intact, stubs older ones.
 * Preserves tool_use_id (required by Anthropic API).
 * Never orphans tool results from their assistant message.
 */
function microCompact(messages: Anthropic.MessageParam[], keepLast: number): void {
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
