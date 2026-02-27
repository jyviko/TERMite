// Agent modes
export type AgentMode = "active" | "stopped";

// Outcome from resolve
export type Outcome = "success" | "partial" | "failure" | "uncertain";

// Drive names
export const DRIVE_NAMES = ["explore", "acquire", "grow", "coordinate"] as const;
export type DriveName = (typeof DRIVE_NAMES)[number];

// Memory types
export type MemoryType = "episodic" | "semantic" | "procedural";

// Prompt phases (the three rewritable prompts)
export type PromptPhase = "systemPrompt" | "resolvePrompt" | "memorizePrompt";

export interface Drive {
  name: DriveName;
  level: number; // 0.0 - 1.0
  threshold: number;
  decayRate: number;
  growthRate: number;
}

export interface Memory {
  id: string;
  context: string;
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
  baseCost: number;
  cycleHistory: CycleRecord[];
}

export interface CycleRecord {
  cycle: number;
  timestamp?: string;   // ISO wall-clock time
  cost: number;
  cacheWriteCost?: number;  // cache write TEQ — infrastructure, excluded from shouldStop
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

export interface Config {
  systemPrompt: string;
  resolvePrompt: string;
  memorizePrompt: string;
  routing: RoutingConfig;
  version: number;
  promptHistory: PromptRewrite[];
}

export interface RouteEntry {
  model: string;
  maxTokens: number;
  maxCycleCost?: number;
}

export interface RoutingConfig {
  thinking: RouteEntry;
  resolve: RouteEntry;
  memorize: RouteEntry;
}

export interface PromptRewrite {
  phase: PromptPhase;
  oldPrompt: string;
  newPrompt: string;
  timestamp: number;
  version: number;
}

export interface DrivePhaseTracking {
  coordinateActiveCycles: number;
}

export interface AgentState {
  id: string;
  generation: number;
  sourceId: string | null;
  createdAt: number;
  active: boolean;
  stopReason: string | null;
  cycleCount: number;
  mode: AgentMode;
  goal: string | null;
  energy: EnergyLedgerData;
  drives: Record<DriveName, Drive>;
  drivePhaseTracking?: DrivePhaseTracking;
  memories: Memory[];
  config: Config;
}

// Strategy fingerprint — appended to metrics.jsonl for post-hoc ALife analysis
export interface StrategyFingerprint {
  memEpisodic: number;
  memSemantic: number;
  memProcedural: number;
  memTotalTokens: number;
  promptVersion: number;
  toolCount: number;
  tier: number;
  baseCost: number;
  cacheWriteCost: number;
  drives: Record<DriveName, number>;
  generation: number;
}

// Task system
export interface Task {
  id: string;
  tier: number;
  title: string;
  verifyScript: string;
  reward: number;
  deadlineCycles: number;
  assignedCycle: number;
  dataFiles?: string[];
}

export interface TaskResult {
  taskId: string;
  tier: number;
  passed: boolean;
  cyclesTaken: number;
}

// Persisted arena entry (for resume)
export interface ArenaEntryData {
  taskTier: number;
  currentTask: Task | null;
  taskHistory: TaskResult[];
  consecutivePasses: number;
  consecutiveFails: number;
  graduated: boolean;
  graduationData?: { datasetName: string; files: string[] };
}

// Agent events
export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool_use"; name: string; input: Record<string, unknown> }
  | { type: "tool_start"; name: string }
  | { type: "tool_result"; name: string; result: string }
  | { type: "usage"; input: number; output: number; cacheCreation: number; cacheRead: number; cumulative: { input: number; output: number; cacheCreation: number; cacheRead: number; iterations: number } }
  | { type: "error"; message: string }
  | { type: "state_change"; from: AgentMode; to: AgentMode }
  | { type: "phase_change"; phase: "executing" | "resolving" | "memorizing" }
  | { type: "tools_available"; tools: string[] };
