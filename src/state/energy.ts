import type { CycleRecord, EnergyLedgerData, Outcome } from "../types/index.js";

export class EnergyLedger {
  budget: number;
  spent: number;
  reserves: number;
  capacity: number;
  earned: number;
  bmr: number;
  cycleHistory: CycleRecord[];

  private cycleCost = 0;
  private cycleIncome = 0;

  constructor(data: Partial<EnergyLedgerData> & { budget: number }) {
    this.budget = data.budget;
    this.spent = data.spent ?? 0;
    this.reserves = data.reserves ?? data.budget;
    this.capacity = data.capacity ?? data.budget;
    this.earned = data.earned ?? 0;
    this.bmr = data.bmr ?? 50;
    this.cycleHistory = data.cycleHistory ?? [];
  }

  burn(phase: string, tokens: number): void {
    const cost = tokens;
    this.reserves -= cost;
    this.spent += cost;
    this.cycleCost += cost;
    if (this.reserves < 0) this.reserves = 0;
  }

  feed(tokens: number): number {
    const space = this.capacity - this.reserves;
    const added = Math.min(tokens, space);
    this.reserves += added;
    this.earned += added;
    this.cycleIncome += added;
    return added;
  }

  computeBmr(memoryTokens: number): number {
    this.bmr = 50 + Math.floor(memoryTokens / 10);
    return this.bmr;
  }

  burnBmr(): void {
    this.burn("bmr", this.bmr);
  }

  endCycle(cycle: number, outcome: Outcome | null, income: number, sources: string, goalRelevance = 0): void {
    this.cycleHistory.push({
      cycle,
      cost: this.cycleCost,
      income,
      net: income - this.cycleCost,
      outcome,
      incomeSources: sources,
      goalRelevance,
    });
    this.cycleCost = 0;
    this.cycleIncome = 0;
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

  get alive(): boolean {
    return this.reserves > 0 && this.spent < this.budget;
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
      bmr: this.bmr,
      cycleHistory: this.cycleHistory,
    };
  }

  static fromJSON(data: EnergyLedgerData): EnergyLedger {
    return new EnergyLedger(data);
  }
}
