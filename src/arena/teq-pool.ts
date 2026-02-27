import { writeFile, readFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface TEQPoolConfig {
  initialBalance: number;
  regenPerCycle: number;
  maxBalance: number;
}

export interface TEQPoolSnapshot {
  balance: number;
  totalWithdrawn: number;
  totalDeposited: number;
  totalRegenerated: number;
  maxBalance: number;
  regenPerCycle: number;
}

const DEFAULT_CONFIG: TEQPoolConfig = {
  initialBalance: 10_000_000,
  regenPerCycle: 50_000,
  maxBalance: 25_000_000,
};

export class TEQPool {
  private static _instance: TEQPool | null = null;

  private balance: number;
  private totalWithdrawn = 0;
  private totalDeposited = 0;
  private totalRegenerated = 0;
  private maxBalance: number;
  private regenPerCycle: number;

  /** Promise-chain serialization for concurrent withdraw safety. */
  private mutex: Promise<void> = Promise.resolve();

  private constructor(config: Partial<TEQPoolConfig> = {}) {
    this.balance = config.initialBalance ?? DEFAULT_CONFIG.initialBalance;
    this.maxBalance = config.maxBalance ?? DEFAULT_CONFIG.maxBalance;
    this.regenPerCycle = config.regenPerCycle ?? DEFAULT_CONFIG.regenPerCycle;
  }

  /** Initialize the singleton with config. Must be called before instance(). */
  static initialize(config: Partial<TEQPoolConfig> = {}): TEQPool {
    if (TEQPool._instance) {
      throw new Error("TEQPool already initialized. Call reset() first if reinitializing.");
    }
    TEQPool._instance = new TEQPool(config);
    return TEQPool._instance;
  }

  /** Get the singleton instance. Throws if not initialized. */
  static instance(): TEQPool {
    if (!TEQPool._instance) {
      throw new Error("TEQPool not initialized. Call TEQPool.initialize() first.");
    }
    return TEQPool._instance;
  }

  /** Reset the singleton (for testing or process restart). */
  static reset(): void {
    TEQPool._instance = null;
  }

  /**
   * Atomically withdraw up to `requested` TEQs.
   * Returns the actual amount withdrawn (may be less if pool is low/empty).
   */
  async withdraw(requested: number): Promise<number> {
    return new Promise<number>((resolve) => {
      this.mutex = this.mutex.then(() => {
        const actual = Math.min(requested, Math.max(0, this.balance));
        this.balance -= actual;
        this.totalWithdrawn += actual;
        resolve(actual);
      });
    });
  }

  /** Return TEQs to the pool (e.g. on agent halt). Capped at maxBalance. */
  deposit(amount: number): void {
    this.balance = Math.min(this.maxBalance, this.balance + amount);
    this.totalDeposited += amount;
  }

  /** Update the regen rate at runtime (e.g. to scale with population × model multiplier). */
  setRegenRate(rate: number): void {
    this.regenPerCycle = rate;
  }

  /** Called on a timer — adds regenPerCycle TEQs, capped at maxBalance. */
  regenerate(): void {
    const added = Math.min(this.regenPerCycle, this.maxBalance - this.balance);
    if (added > 0) {
      this.balance += added;
      this.totalRegenerated += added;
    }
  }

  snapshot(): TEQPoolSnapshot {
    return {
      balance: this.balance,
      totalWithdrawn: this.totalWithdrawn,
      totalDeposited: this.totalDeposited,
      totalRegenerated: this.totalRegenerated,
      maxBalance: this.maxBalance,
      regenPerCycle: this.regenPerCycle,
    };
  }

  toJSON(): TEQPoolSnapshot {
    return this.snapshot();
  }

  async persist(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(this.toJSON(), null, 2), "utf-8");
  }

  /** Load persisted state into the singleton, or initialize fresh. */
  static async loadOrCreate(path: string, config: Partial<TEQPoolConfig> = {}): Promise<TEQPool> {
    try {
      const raw = await readFile(path, "utf-8");
      const data: TEQPoolSnapshot = JSON.parse(raw);
      const pool = TEQPool.initialize({
        initialBalance: data.balance,
        maxBalance: data.maxBalance,
        regenPerCycle: data.regenPerCycle,
      });
      pool.totalWithdrawn = data.totalWithdrawn;
      pool.totalDeposited = data.totalDeposited;
      pool.totalRegenerated = data.totalRegenerated;
      return pool;
    } catch {
      return TEQPool.initialize(config);
    }
  }
}
