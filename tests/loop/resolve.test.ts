import { describe, it, expect } from "vitest";
import { computeIncome } from "../../src/loop/resolve.js";

describe("computeIncome", () => {
  it("computes quest reward", () => {
    const { amount, sources } = computeIncome(0.5, "partial", 25000);
    expect(amount).toBe(25000 + 1250); // quest + relevance (floor(2500 * 0.5))
    expect(sources).toContain("quest:25000");
  });

  it("adds success bonus", () => {
    const { amount, sources } = computeIncome(0.8, "success", null);
    expect(amount).toBe(5000 + 2000); // success + relevance (floor(2500 * 0.8))
    expect(sources).toContain("success:5000");
  });

  it("relevance-scaled income", () => {
    const { amount } = computeIncome(0.6, "partial", null);
    expect(amount).toBe(1500); // floor(2500 * 0.6)
  });

  it("zero relevance gives zero income", () => {
    const { amount } = computeIncome(0, "failure", null);
    expect(amount).toBe(0);
  });

  it("full relevance with quest and success", () => {
    const { amount, sources } = computeIncome(1.0, "success", 60000);
    expect(amount).toBe(60000 + 5000 + 2500);
    expect(sources).toHaveLength(3);
  });
});
