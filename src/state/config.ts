import type { Config as ConfigData, PromptRewrite, RoutingConfig } from "../types/index.js";
import { DEFAULT_SYSTEM_PROMPT, DEFAULT_RESOLVE_PROMPT, DEFAULT_REST_PROMPT, DEFAULT_MEMORIZE_PROMPT, DEFAULT_ROUTING } from "./defaults.js";

export class Config {
  systemPrompt: string;
  resolvePrompt: string;
  restPrompt: string;
  memorizePrompt: string;
  routing: RoutingConfig;
  version: number;
  promptHistory: PromptRewrite[];

  constructor(data?: Partial<ConfigData>) {
    this.systemPrompt = data?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.resolvePrompt = data?.resolvePrompt ?? DEFAULT_RESOLVE_PROMPT;
    this.restPrompt = data?.restPrompt ?? DEFAULT_REST_PROMPT;
    this.memorizePrompt = data?.memorizePrompt ?? DEFAULT_MEMORIZE_PROMPT;
    this.routing = data?.routing
      ? { thinking: { ...data.routing.thinking }, resolve: { ...data.routing.resolve } }
      : { thinking: { ...DEFAULT_ROUTING.thinking }, resolve: { ...DEFAULT_ROUTING.resolve } };
    this.version = data?.version ?? 0;
    this.promptHistory = data?.promptHistory ?? [];
  }

  mutate(phase: string, newPrompt: string): void {
    const current = this.getPrompt(phase);
    if (!current || !newPrompt.trim()) return;

    this.promptHistory.push({
      phase,
      oldPrompt: current,
      newPrompt,
      timestamp: Date.now(),
      version: this.version,
    });

    this.setPrompt(phase, newPrompt);
    this.version++;
  }

  private getPrompt(phase: string): string | null {
    switch (phase) {
      case "systemPrompt": return this.systemPrompt;
      case "resolvePrompt": return this.resolvePrompt;
      case "restPrompt": return this.restPrompt;
      case "memorizePrompt": return this.memorizePrompt;
      default: return null;
    }
  }

  private setPrompt(phase: string, prompt: string): void {
    switch (phase) {
      case "systemPrompt": this.systemPrompt = prompt; break;
      case "resolvePrompt": this.resolvePrompt = prompt; break;
      case "restPrompt": this.restPrompt = prompt; break;
      case "memorizePrompt": this.memorizePrompt = prompt; break;
    }
  }

  toJSON(): ConfigData {
    return {
      systemPrompt: this.systemPrompt,
      resolvePrompt: this.resolvePrompt,
      restPrompt: this.restPrompt,
      memorizePrompt: this.memorizePrompt,
      routing: this.routing,
      version: this.version,
      promptHistory: this.promptHistory,
    };
  }

  static fromJSON(data: ConfigData): Config {
    return new Config(data);
  }
}
