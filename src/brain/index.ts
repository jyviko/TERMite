import Anthropic from "@anthropic-ai/sdk";
import type { AgentEvent } from "../types/index.js";

export interface TokenUsage {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}

export interface BrainResponse {
  content: Anthropic.ContentBlock[];
  stopReason: "end_turn" | "tool_use" | "max_tokens";
  usage: TokenUsage;
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
    const baseURL = config.baseUrl ?? process.env.ANTHROPIC_BASE_URL;
    console.log(`[Brain] baseURL=${baseURL ?? "(default)"}`);
    this.client = new Anthropic({
      defaultHeaders: { 'X-Api-Key': null },  
      baseURL,
      timeout: config.timeout ?? 120_000,
    });
  }

  async chat(params: ChatParams): Promise<BrainResponse> {
    const systemBlocks: Anthropic.TextBlockParam[] = params.system
      ? [{ type: "text" as const, text: params.system, cache_control: { type: "ephemeral" as const } }]
      : [];

    const tools = params.tools ? this.withCacheControl(params.tools) : undefined;
    const messages = this.withMessageCacheBreakpoint(params.messages);

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const response = await this.client.messages.create({
          model: params.model,
          max_tokens: params.maxTokens,
          system: systemBlocks.length > 0 ? systemBlocks : undefined,
          messages,
          tools: tools && tools.length > 0 ? tools : undefined,
          temperature: params.temperature,
        });

        const cacheUsage = response.usage as unknown as Record<string, unknown>;
        return {
          content: response.content,
          stopReason: response.stop_reason as BrainResponse["stopReason"],
          usage: {
            input: response.usage.input_tokens,
            output: response.usage.output_tokens,
            cacheCreation: (cacheUsage.cache_creation_input_tokens as number) ?? 0,
            cacheRead: (cacheUsage.cache_read_input_tokens as number) ?? 0,
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

  /**
   * Add a cache breakpoint to the last user message so that on the next
   * API call the entire prefix (system + tools + prior turns) is a cache hit.
   * Returns a shallow copy — does not mutate the original array.
   */
  private withMessageCacheBreakpoint(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
    if (messages.length < 2) return messages;

    // Find the last user message
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role === "user") { lastUserIdx = i; break; }
    }
    if (lastUserIdx < 0) return messages;

    const out = messages.slice();
    const msg = out[lastUserIdx]!;
    const cc = { cache_control: { type: "ephemeral" as const } };

    if (typeof msg.content === "string") {
      out[lastUserIdx] = {
        role: "user",
        content: [{ type: "text" as const, text: msg.content, ...cc }],
      };
    } else if (Array.isArray(msg.content) && msg.content.length > 0) {
      const blocks = (msg.content as Anthropic.ContentBlockParam[]).slice();
      const last = blocks[blocks.length - 1]!;
      blocks[blocks.length - 1] = { ...last, ...cc } as Anthropic.ContentBlockParam;
      out[lastUserIdx] = { role: "user", content: blocks };
    }

    return out;
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
