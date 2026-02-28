import Anthropic from "@anthropic-ai/sdk";

export interface TokenUsage {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}

export const ZERO_USAGE: TokenUsage = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };

export interface LLMResponse {
  content: Anthropic.ContentBlock[];
  stopReason: "end_turn" | "tool_use" | "max_tokens";
  usage: TokenUsage;
}

export interface LLMConfig {
  apiKey?: string;
  baseUrl?: string;
  timeout?: number;
  maxConcurrency?: number;
}

export interface ChatParams {
  model: string;
  system?: string;
  messages: Anthropic.MessageParam[];
  tools?: Anthropic.Tool[];
  maxTokens: number;
  temperature?: number;
  /** Skip prompt caching (no cache_control breakpoints). Use for single-shot calls. */
  skipCache?: boolean;
}

const MAX_RETRIES = 5;
const BASE_RETRY_MS = 1000;
const MAX_RETRY_MS = 60_000;

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Concurrency-limited LLM client with adaptive rate limiting.
 *
 * - Caps in-flight requests via a semaphore (default 10).
 * - On 429, reads `retry-after` header; if absent uses exponential backoff
 *   with jitter. All waiters are paused during a 429 cooldown so only one
 *   retry fires at a time.
 * - On 529 (overloaded), applies the same backoff logic.
 */
export class LLM {
  private client: Anthropic;

  // Concurrency semaphore
  private maxConcurrency: number;
  private inflight = 0;
  private waitQueue: (() => void)[] = [];

  // Global 429 cooldown — when set, all new requests wait until this time
  private cooldownUntil = 0;

  constructor(config: LLMConfig = {}) {
    const baseURL = config.baseUrl ?? process.env.ANTHROPIC_BASE_URL;
    console.log(`[LLM] baseURL=${baseURL ?? "(default)"}`);
    this.client = new Anthropic({
      defaultHeaders: { "X-Api-Key": null },
      baseURL,
      timeout: config.timeout ?? 120_000,
    });
    this.maxConcurrency = config.maxConcurrency ?? 10;
  }

  async chat(params: ChatParams): Promise<LLMResponse> {
    const cache = !params.skipCache;
    const systemBlocks: Anthropic.TextBlockParam[] = params.system
      ? [cache
          ? { type: "text" as const, text: params.system, cache_control: { type: "ephemeral" as const } }
          : { type: "text" as const, text: params.system }]
      : [];

    const tools = params.tools
      ? (cache ? this.withCacheControl(params.tools) : params.tools)
      : undefined;
    const messages = cache
      ? this.withMessageCacheBreakpoint(params.messages)
      : params.messages;

    await this.acquireSlot();
    try {
      return await this.chatWithRetry(systemBlocks, messages, tools, params);
    } finally {
      this.releaseSlot();
    }
  }

  private async chatWithRetry(
    systemBlocks: Anthropic.TextBlockParam[],
    messages: Anthropic.MessageParam[],
    tools: Anthropic.Tool[] | undefined,
    params: ChatParams,
  ): Promise<LLMResponse> {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      // Respect global cooldown before each attempt
      await this.waitForCooldown();

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
          stopReason: response.stop_reason as LLMResponse["stopReason"],
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
            const waitMs = this.computeBackoff(err, attempt);
            // Set global cooldown so other concurrent requests also back off
            this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + waitMs);
            console.log(
              `[LLM] ${err.status} on attempt ${attempt + 1}/${MAX_RETRIES}, ` +
              `backing off ${Math.round(waitMs / 1000)}s (inflight: ${this.inflight}/${this.maxConcurrency})`,
            );
            await sleep(waitMs);
            continue;
          }
        }
        throw err;
      }
    }
    throw new Error("LLM: max retries exhausted");
  }

  private computeBackoff(err: InstanceType<typeof Anthropic.APIError>, attempt: number): number {
    // Check for retry-after header (Anthropic sends this on 429)
    const retryAfter = err.headers?.get?.("retry-after") ?? undefined;
    if (retryAfter) {
      const seconds = parseFloat(retryAfter);
      if (!isNaN(seconds) && seconds > 0) {
        return Math.min(seconds * 1000, MAX_RETRY_MS);
      }
    }
    // Exponential backoff with jitter: 1s, 2s, 4s, 8s, 16s + up to 1s jitter
    const base = Math.min(BASE_RETRY_MS * Math.pow(2, attempt), MAX_RETRY_MS);
    const jitter = Math.random() * 1000;
    return base + jitter;
  }

  private async waitForCooldown(): Promise<void> {
    const remaining = this.cooldownUntil - Date.now();
    if (remaining > 0) {
      await sleep(remaining);
    }
  }

  // --- Concurrency semaphore ---

  private acquireSlot(): Promise<void> {
    if (this.inflight < this.maxConcurrency) {
      this.inflight++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waitQueue.push(() => {
        this.inflight++;
        resolve();
      });
    });
  }

  private releaseSlot(): void {
    this.inflight--;
    const next = this.waitQueue.shift();
    if (next) next();
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
