import { describe, expect, it } from "vitest";
import { BudgetGuard } from "@corpix/agents";
import { BudgetExceededError } from "@corpix/shared";

const pricing = {
  m: { input: 1_000, output: 2_000, cached_input: 100 },
};

describe("BudgetGuard", () => {
  it("prices fresh, cached and output tokens", () => {
    const guard = new BudgetGuard({ budgetUsd: 100, action: "pause", pricing });
    const cost = guard.costOf("m", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cachedInputTokens: 0,
    });
    expect(cost).toBeCloseTo(3_000);
  });

  it("charges cached input at the cached rate", () => {
    const guard = new BudgetGuard({ budgetUsd: 100, action: "pause", pricing });
    const cost = guard.costOf("m", {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cachedInputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(100);
  });

  it("treats unknown models as free", () => {
    const guard = new BudgetGuard({ budgetUsd: 1, action: "pause", pricing });
    expect(guard.costOf("unknown", { inputTokens: 1000, outputTokens: 1000 })).toBe(0);
  });

  it("pauses after the cap is exceeded", () => {
    const guard = new BudgetGuard({ budgetUsd: 1, action: "pause", pricing });
    guard.record("a", "t", "m", { inputTokens: 0, outputTokens: 600_000 });
    expect(guard.isPaused).toBe(true);
    expect(() => guard.assertWithinLimits()).toThrow(BudgetExceededError);
  });

  it("stops instead of pausing when configured", () => {
    const guard = new BudgetGuard({ budgetUsd: 1, action: "stop", pricing });
    guard.record("a", "t", "m", { inputTokens: 0, outputTokens: 600_000 });
    expect(guard.isStopped).toBe(true);
    expect(guard.isPaused).toBe(false);
  });

  it("resume clears the pause", () => {
    const guard = new BudgetGuard({ budgetUsd: 1, action: "pause", pricing });
    guard.record("a", "t", "m", { inputTokens: 0, outputTokens: 600_000 });
    guard.resume(1);
    expect(() => guard.assertWithinLimits()).not.toThrow();
    expect(guard.budgetUsd).toBe(2);
  });
});
