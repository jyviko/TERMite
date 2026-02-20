import Anthropic from "@anthropic-ai/sdk";
import type { AgentEvent } from "../types/index.js";

export interface BrainResponse {
  content: Anthropic.ContentBlock[];
  stopReason: "end_turn" | "tool_use" | "max_tokens";
  usage: { input: number; output: number };
}

export interface BrainConfig {
  apiKey?: string;
  baseUrl?: string;
  timeout?: number;
}

export interface ChatParams {
  model: string;
  system?: string;
  messages: Anthropic.MessageParam[];
  tools?: Anthropic.Tool[];
  maxTokens: number;
  temperature?: number;
}

export interface StreamParams {
  model: string;
  system?: string;
  messages: Anthropic.MessageParam[];
  tools?: Anthropic.Tool[];
  maxTokens: number;
  signal?: AbortSignal;
}

const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 2000, 4000];

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

export class Brain {
  private client: Anthropic;

  constructor(config: BrainConfig = {}) {
    this.client = new Anthropic({
      apiKey: config.baseUrl ? undefined : config.apiKey,
      baseURL: config.baseUrl,
      timeout: config.timeout ?? 120_000,
    });
  }

  async chat(params: ChatParams): Promise<BrainResponse> {
    const systemBlocks: Anthropic.TextBlockParam[] = params.system
      ? [{ type: "text" as const, text: params.system, cache_control: { type: "ephemeral" as const } }]
      : [];

    const tools = params.tools ? this.withCacheControl(params.tools) : undefined;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const response = await this.client.messages.create({
          model: params.model,
          max_tokens: params.maxTokens,
          system: systemBlocks.length > 0 ? systemBlocks : undefined,
          messages: params.messages,
          tools: tools && tools.length > 0 ? tools : undefined,
          temperature: params.temperature,
        });

        return {
          content: response.content,
          stopReason: response.stop_reason as BrainResponse["stopReason"],
          usage: {
            input: response.usage.input_tokens,
            output: response.usage.output_tokens,
          },
        };
      } catch (err: unknown) {
        if (err instanceof Anthropic.APIError) {
          if (err.status === 401 || err.status === 400) throw err;
          if (isRetryable(err.status) && attempt < MAX_RETRIES - 1) {
            await sleep(RETRY_DELAYS[attempt]!);
            continue;
          }
        }
        throw err;
      }
    }
    throw new Error("Brain: max retries exhausted");
  }

  async *stream(params: StreamParams): AsyncGenerator<AgentEvent> {
    const systemBlocks: Anthropic.TextBlockParam[] = params.system
      ? [{ type: "text" as const, text: params.system, cache_control: { type: "ephemeral" as const } }]
      : [];

    const tools = params.tools ? this.withCacheControl(params.tools) : undefined;

    const stream = this.client.messages.stream({
      model: params.model,
      max_tokens: params.maxTokens,
      system: systemBlocks.length > 0 ? systemBlocks : undefined,
      messages: params.messages,
      tools: tools && tools.length > 0 ? tools : undefined,
    });

    if (params.signal) {
      params.signal.addEventListener("abort", () => stream.abort(), { once: true });
    }

    let currentToolName: string | null = null;
    let toolInputJson = "";

    for await (const event of stream) {
      switch (event.type) {
        case "content_block_start":
          if (event.content_block.type === "tool_use") {
            currentToolName = event.content_block.name;
            toolInputJson = "";
            yield { type: "tool_start", name: currentToolName };
          }
          break;

        case "content_block_delta":
          if (event.delta.type === "text_delta") {
            yield { type: "text", text: event.delta.text };
          } else if (event.delta.type === "input_json_delta") {
            toolInputJson += event.delta.partial_json;
          }
          break;

        case "content_block_stop":
          if (currentToolName) {
            let input: Record<string, unknown> = {};
            try {
              input = toolInputJson ? JSON.parse(toolInputJson) : {};
            } catch {
              // degrade to empty object
            }
            yield { type: "tool_use", name: currentToolName, input };
            currentToolName = null;
            toolInputJson = "";
          }
          break;
      }
    }
  }

  private withCacheControl(tools: Anthropic.Tool[]): Anthropic.Tool[] {
    if (tools.length === 0) return tools;
    return tools.map((t, i) =>
      i === tools.length - 1
        ? { ...t, cache_control: { type: "ephemeral" as const } }
        : t,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
