import { describe, expect, it } from "vitest";
import { BUDGETS, BREAKER } from "../src/config.js";

describe("BUDGETS", () => {
  it("sets the total request budget", () => {
    expect(BUDGETS.TOTAL_MS).toBe(3000);
  });

  it("sets the LLM call deadline", () => {
    expect(BUDGETS.LLM_CALL_MS).toBe(2200);
  });
});

describe("BREAKER", () => {
  it("sets the window size", () => {
    expect(BREAKER.WINDOW_SIZE).toBe(20);
  });

  it("sets the open duration", () => {
    expect(BREAKER.OPEN_MS).toBe(60_000);
  });

  it("sets the number of sustained windows required to trip", () => {
    expect(BREAKER.SUSTAINED_WINDOWS).toBe(2);
  });

  it("sets the violation rate threshold", () => {
    expect(BREAKER.THRESHOLDS.VIOLATION_RATE).toBe(0.10);
  });

  it("sets the timeout rate threshold", () => {
    expect(BREAKER.THRESHOLDS.TIMEOUT_RATE).toBe(0.50);
  });

  it("sets the PII rate threshold", () => {
    expect(BREAKER.THRESHOLDS.PII_RATE).toBe(0.10);
  });

  it("sets the p99 latency threshold", () => {
    expect(BREAKER.THRESHOLDS.P99_MS).toBe(2200);
  });
});
