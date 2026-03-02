export class SharedBudget {
  total: number;
  spent: number;

  constructor(total: number) {
    this.total = total;
    this.spent = 0;
  }

  get available(): number {
    return Math.max(0, this.total - this.spent);
  }

  get exhausted(): boolean {
    return this.spent >= this.total;
  }
}
