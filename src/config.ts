/**
 * Central configuration constants for the LLM reply-suggestion service.
 *
 * Every later module imports these values instead of hard-coding numbers.
 */

/** Time budgets in milliseconds. */
export const BUDGETS = { TOTAL_MS: 3000, LLM_CALL_MS: 2200 } as const;

/** Circuit-breaker thresholds and window parameters. */
export const BREAKER = {
  WINDOW_SIZE: 20,
  OPEN_MS: 60_000,
  SUSTAINED_WINDOWS: 2,
  THRESHOLDS: {
    VIOLATION_RATE: 0.10,
    TIMEOUT_RATE: 0.50,
    PII_RATE: 0.10,
    P99_MS: 2200,
  },
} as const;
