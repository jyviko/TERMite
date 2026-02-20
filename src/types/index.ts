import Anthropic from "@anthropic-ai/sdk";

// Organism modes
export type OrganismMode = "forage" | "dead";

// Outcome from resolve
export type Outcome = "success" | "partial" | "failure" | "uncertain";

// Drive names
export type DriveName = "orient" | "metabolize" | "grow" | "coordinate";

// Memory types
export type MemoryType = "episodic" | "semantic" | "procedural";

export interface Drive {
  name: DriveName;
  level: number; // 0.0 - 1.0
  threshold: number;
  decayRate: number;
  growthRate: number;
}

export interface Memory {
  id: string;
  content: string;
  type: MemoryType;
  importance: number;
  accessCount: number;
  createdAt: number;
  lastAccessed: number;
  energySaved: number;
  tokenCost: number;
}

export interface EnergyLedgerData {
  budget: number;
  spent: number;
  reserves: number;
  capacity: number;
  earned: number;
  earnedFromPrizes: number;
  bmr: number;
  cycleHistory: CycleRecord[];
}

export interface CycleRecord {
  cycle: number;
  cost: number;
  income: number;
  net: number;
  outcome: Outcome | null;
  incomeSources: string;
  goalRelevance: number;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
}

export interface Genome {
  systemPrompt: string;
  resolvePrompt: string;
  restPrompt: string;
  memorizePrompt: string;
  routing: RoutingConfig;
  version: number;
  promptHistory: PromptMutation[];
}

export interface RoutingConfig {
  fast: { model: string; maxTokens: number };
  deep: { model: string; maxTokens: number };
  resolve: { model: string; maxTokens: number };
}

export interface PromptMutation {
  phase: string;
  oldPrompt: string;
  newPrompt: string;
  timestamp: number;
  version: number;
}

export interface OrganismState {
  id: string;
  generation: number;
  parentId: string | null;
  bornAt: number;
  alive: boolean;
  causeOfDeath: string | null;
  cycleCount: number;
  mode: OrganismMode;
  goal: string | null;
  energy: EnergyLedgerData;
  drives: Record<DriveName, Drive>;
  memories: Memory[];
  genome: Genome;
}

// Re-export Anthropic's types directly
export type MessageParam = Anthropic.MessageParam;
export type ContentBlock = Anthropic.ContentBlock;
export type ContentBlockParam = Anthropic.ContentBlockParam;
export type ToolUseBlock = Anthropic.ToolUseBlock;
export type ToolResultBlockParam = Anthropic.ToolResultBlockParam;
export type TextBlockParam = Anthropic.TextBlockParam;

// Tool definition — matches Anthropic.Tool
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Anthropic.Tool.InputSchema;
}

// Quest system
export interface Quest {
  id: string;
  tier: number;
  title: string;
  description: string;
  verifyScript: string;
  reward: number;
  deadlineCycles: number;
  assignedCycle: number;
  dataFiles?: string[];
}

export interface QuestResult {
  questId: string;
  tier: number;
  passed: boolean;
  cyclesTaken: number;
}

// Skill manifest entry
export interface SkillEntry {
  description: string;
  path: string;
  usage: string;
  lastUsed: number;
}

// Agent events
export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool_use"; name: string; input: Record<string, unknown> }
  | { type: "tool_start"; name: string }
  | { type: "tool_result"; name: string; result: string }
  | { type: "usage"; input: number; output: number; cacheCreation: number; cacheRead: number }
  | { type: "error"; message: string }
  | { type: "state_change"; from: OrganismMode; to: OrganismMode };
