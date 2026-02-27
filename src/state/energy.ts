import type { CycleRecord, EnergyLedgerData, Outcome } from "../types/index.js";

// ── Model pricing (dimensionless multipliers from Anthropic $/MTok) ──
// Normalized so Haiku 4.5 base input = 1.0x.
// Energy is in "effective tokens" — 1 Haiku input token = 1 energy.
// A Sonnet output token = 15 energy (reflecting its 15x higher cost).
interface ModelPricing {
  input: number;       // base (uncached) input multiplier
  cacheWrite: number;  // cache write multiplier
  cacheRead: number;   // cache hit multiplier
  output: number;      // output multiplier
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  // Haiku 4.5:  $1 / $1.25 / $0.10 / $5  → 1x / 1.25x / 0.1x / 5x
  "claude-haiku-4-5-20251001": { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 },
  // Haiku 3.5:  $0.80 / $1 / $0.08 / $4
  "claude-haiku-3-5":          { input: 0.8, cacheWrite: 1, cacheRead: 0.08, output: 4 },
  // Haiku 3:    $0.25 / $0.30 / $0.03 / $1.25
  "claude-haiku-3":            { input: 0.25, cacheWrite: 0.3, cacheRead: 0.03, output: 1.25 },
  // Sonnet 4.x: $3 / $3.75 / $0.30 / $15
  "claude-sonnet-4-6":         { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
  "claude-sonnet-4-5":         { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
  "claude-sonnet-4":           { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
  // Opus 4.5/4.6: $5 / $6.25 / $0.50 / $25
  "claude-opus-4-6":           { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 },
  "claude-opus-4-5":           { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 },
  // Opus 4/4.1:   $15 / $18.75 / $1.50 / $75
  "claude-opus-4-1":           { input: 15, cacheWrite: 18.75, cacheRead: 1.5, output: 75 },
  "claude-opus-4":             { input: 15, cacheWrite: 18.75, cacheRead: 1.5, output: 75 },
};

// Fallback: Haiku 4.5 (cheapest current model)
const DEFAULT_PRICING: ModelPricing = MODEL_PRICING["claude-haiku-4-5-20251001"]!;

function lookupPricing(model: string): ModelPricing {
  // Exact match first
  if (MODEL_PRICING[model]) return MODEL_PRICING[model];
  // Prefix match (handles version suffixes like -20251001)
  for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
    if (model.startsWith(key) || key.startsWith(model)) return pricing;
  }
  return DEFAULT_PRICING;
}

export interface TokenUsageBreakdown {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}

/**
 * Compute energy cost in TEQ (token equivalents) — dimensionless.
 * 1 TEQ = 1 Haiku base input token. All other costs scale from there
 * using the same ratios as Anthropic's $/MTok pricing.
 *
 * Examples (Haiku 4.5):
 *   100 output tokens   → 500 TEQ  (5x multiplier)
 *   100 cached input    → 10 TEQ   (0.1x multiplier)
 *   100 uncached input  → 100 TEQ  (1x multiplier)
 *
 * Examples (Sonnet 4.6):
 *   100 output tokens   → 1500 TEQ (15x multiplier)
 *   100 cached input    → 30 TEQ   (0.3x multiplier)
 *   100 uncached input  → 300 TEQ  (3x multiplier)
 */
export function computeEnergyCost(model: string, usage: TokenUsageBreakdown): number {
  const pricing = lookupPricing(model);
  const uncachedInput = Math.max(0, usage.input - usage.cacheCreation - usage.cacheRead);
  return Math.ceil(
    uncachedInput * pricing.input +
    usage.cacheCreation * pricing.cacheWrite +
    usage.cacheRead * pricing.cacheRead +
    usage.output * pricing.output
  );
}

export class EnergyLedger {
  budget: number;
  spent: number;
  reserves: number;
  capacity: number;
  earned: number;
  earnedFromPrizes: number;
  baseCost: number;
  cycleHistory: CycleRecord[];

  private cycleCost = 0;
  private cycleIncome = 0;
  private cycleInputTokens = 0;
  private cycleOutputTokens = 0;
  private cycleCacheCreation = 0;
  private cycleCacheRead = 0;

  constructor(data: Partial<EnergyLedgerData> & { budget: number }) {
    this.budget = data.budget;
    this.spent = data.spent ?? 0;
    this.reserves = data.reserves ?? data.budget;
    this.capacity = data.capacity ?? data.budget;
    this.earned = data.earned ?? 0;
    this.earnedFromPrizes = data.earnedFromPrizes ?? 0;
    this.baseCost = data.baseCost ?? 50;
    this.cycleHistory = data.cycleHistory ?? [];
  }

  burn(model: string, usage: TokenUsageBreakdown): void {
    const cost = computeEnergyCost(model, usage);
    this.reserves -= cost;
    this.spent += cost;
    this.cycleCost += cost;
    if (this.reserves < 0) this.reserves = 0;

    // Track raw token breakdown for observability
    this.cycleInputTokens += usage.input;
    this.cycleOutputTokens += usage.output;
    this.cycleCacheCreation += usage.cacheCreation;
    this.cycleCacheRead += usage.cacheRead;
  }

  credit(tokens: number): number {
    this.reserves += tokens;
    this.earned += tokens;
    this.cycleIncome += tokens;
    // Capacity grows with reserves — agents can accumulate wealth
    if (this.reserves > this.capacity) {
      this.capacity = this.reserves;
    }
    return tokens;
  }

  /** Credit TEQs sourced from the shared pool. Tracks pool-sourced income separately. */
  creditFromPool(tokens: number): number {
    const added = this.credit(tokens);
    this.earnedFromPrizes += added;
    return added;
  }

  computeBaseCost(memoryTokens: number, toolCount = 0): number {
    this.baseCost = 50 + Math.floor(memoryTokens / 10) + toolCount * 20;
    return this.baseCost;
  }

  burnBaseCost(): void {
    // Base cost is a flat overhead, not an API call — deduct directly
    this.reserves -= this.baseCost;
    this.spent += this.baseCost;
    this.cycleCost += this.baseCost;
    if (this.reserves < 0) this.reserves = 0;
  }

  burnFlat(cost: number): void {
    this.reserves -= cost;
    this.spent += cost;
    this.cycleCost += cost;
    if (this.reserves < 0) this.reserves = 0;
  }

  endCycle(cycle: number, outcome: Outcome | null, sources: string, goalRelevance = 0, model?: string): void {
    // Use actual credited income (from credit/creditFromPool), not requested amount
    const actualIncome = this.cycleIncome;
    this.cycleHistory.push({
      cycle,
      timestamp: new Date().toISOString(),
      cost: this.cycleCost,
      income: actualIncome,
      net: actualIncome - this.cycleCost,
      outcome,
      incomeSources: sources,
      goalRelevance,
      model,
      inputTokens: this.cycleInputTokens,
      outputTokens: this.cycleOutputTokens,
      cacheCreationTokens: this.cycleCacheCreation,
      cacheReadTokens: this.cycleCacheRead,
    });
    this.cycleCost = 0;
    this.cycleIncome = 0;
    this.cycleInputTokens = 0;
    this.cycleOutputTokens = 0;
    this.cycleCacheCreation = 0;
    this.cycleCacheRead = 0;
  }

  avgCycleCost(lastN?: number): number {
    const history = lastN ? this.cycleHistory.slice(-lastN) : this.cycleHistory;
    if (history.length === 0) return 0;
    return history.reduce((sum, r) => sum + r.cost, 0) / history.length;
  }

  get remaining(): number {
    return this.reserves;
  }

  get headroom(): number {
    return this.budget - this.spent;
  }

  get active(): boolean {
    return this.reserves > 0;
  }

  get currentCycleCost(): number {
    return this.cycleCost;
  }

  get ratio(): number {
    return this.capacity > 0 ? this.reserves / this.capacity : 0;
  }

  toJSON(): EnergyLedgerData {
    return {
      budget: this.budget,
      spent: this.spent,
      reserves: this.reserves,
      capacity: this.capacity,
      earned: this.earned,
      earnedFromPrizes: this.earnedFromPrizes,
      baseCost: this.baseCost,
      cycleHistory: this.cycleHistory,
    };
  }

  static fromJSON(data: EnergyLedgerData): EnergyLedger {
    return new EnergyLedger(data);
  }
}
