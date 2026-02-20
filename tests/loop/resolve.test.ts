import { describe, it, expect } from "vitest";
import { computeIncome } from "../../src/loop/resolve.js";

describe("computeIncome", () => {
  it("computes quest reward", () => {
    const { amount, sources } = computeIncome(0.5, "partial", 5000);
    expect(amount).toBe(5000 + 250); // quest + relevance
    expect(sources).toContain("quest:5000");
  });

  it("adds success bonus", () => {
    const { amount, sources } = computeIncome(0.8, "success", null);
    expect(amount).toBe(1000 + 400); // success + relevance
    expect(sources).toContain("success:1000");
  });

  it("relevance-scaled income", () => {
    const { amount } = computeIncome(0.6, "partial", null);
    expect(amount).toBe(300); // floor(500 * 0.6)
  });

  it("zero relevance gives zero income", () => {
    const { amount } = computeIncome(0, "failure", null);
    expect(amount).toBe(0);
  });

  it("full relevance with quest and success", () => {
    const { amount, sources } = computeIncome(1.0, "success", 10000);
    expect(amount).toBe(10000 + 1000 + 500);
    expect(sources).toHaveLength(3);
  });
});
