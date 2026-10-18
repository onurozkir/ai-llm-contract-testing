/**
 * In-memory rolling metrics window and circuit breaker with kill thresholds.
 */
import { BREAKER } from "./config.js";

export type CallOutcome =
  | "accepted"
  | "unavailable"
  | "violation"
  | "timeout"
  | "pii_detected";

export type WindowSnapshot = {
  counts: Record<CallOutcome, number>; // within rolling window of last BREAKER.WINDOW_SIZE outcomes
  p99Ms: number | null; // from latency samples; timeouts recorded WITHOUT latencyMs are excluded
};

/**
 * Tracks a rolling window of recent call outcomes and latency samples.
 */
export class Metrics {
  private events: Array<{ outcome: CallOutcome; latencyMs?: number }> = [];

  record(outcome: CallOutcome, latencyMs?: number): void {
    this.events.push({ outcome, latencyMs });
    if (this.events.length > BREAKER.WINDOW_SIZE) {
      this.events.shift();
    }
  }

  snapshot(): WindowSnapshot {
    const counts: Record<CallOutcome, number> = {
      accepted: 0,
      unavailable: 0,
      violation: 0,
      timeout: 0,
      pii_detected: 0,
    };
    const latencies: number[] = [];

    for (const e of this.events) {
      counts[e.outcome]++;
      if (e.latencyMs !== undefined) {
        latencies.push(e.latencyMs);
      }
    }

    latencies.sort((a, b) => a - b);
    let p99Ms: number | null = null;
    if (latencies.length > 0) {
      const idx = Math.ceil(0.99 * latencies.length) - 1;
      p99Ms = latencies[Math.max(0, idx)];
    }

    return { counts, p99Ms };
  }
}

/**
 * Pure evaluation function: true = window conditions indicate breaker should open.
 */
export function evaluateWindow(snap: WindowSnapshot): boolean {
  const total =
    snap.counts.accepted +
    snap.counts.unavailable +
    snap.counts.violation +
    snap.counts.timeout +
    snap.counts.pii_detected;

  if (total === 0) return false;

  const violationDenominator = total - snap.counts.unavailable;
  if (
    violationDenominator > 0 &&
    snap.counts.violation / violationDenominator >
      BREAKER.THRESHOLDS.VIOLATION_RATE
  ) {
    return true;
  }

  if (snap.counts.timeout / total > BREAKER.THRESHOLDS.TIMEOUT_RATE) {
    return true;
  }

  if (snap.counts.pii_detected / total > BREAKER.THRESHOLDS.PII_RATE) {
    return true;
  }

  if (snap.p99Ms !== null && snap.p99Ms > BREAKER.THRESHOLDS.P99_MS) {
    return true;
  }

  return false;
}

/**
 * Circuit breaker that manages call gating based on rolling metrics,
 * sustained latency evaluation streaks, and half-open probe recovery.
 */
export class CircuitBreaker {
  private openedAt: number | null = null;
  private halfOpenProbeDispatched = false;
  private p99Streak = 0;
  private lastEvaluatedP99: number | null = null;
  private metrics = new Metrics();

  constructor(private now: () => number = Date.now) {}

  allowCall(): boolean {
    const s = this.state();
    if (s === "closed") return true;
    if (s === "open") return false;
    // half_open: exactly one probe call allowed
    if (!this.halfOpenProbeDispatched) {
      this.halfOpenProbeDispatched = true;
      return true;
    }
    return false;
  }

  state(): "closed" | "open" | "half_open" {
    if (this.openedAt === null) return "closed";
    if (this.now() - this.openedAt >= BREAKER.OPEN_MS) {
      return "half_open";
    }
    return "open";
  }

  private trip(): void {
    this.openedAt = this.now();
    this.halfOpenProbeDispatched = false;
  }

  recordAccepted(latencyMs: number): void {
    if (this.state() === "half_open") {
      this.openedAt = null;
      this.halfOpenProbeDispatched = false;
      this.p99Streak = 0;
      this.lastEvaluatedP99 = null;
    }

    this.metrics.record("accepted", latencyMs);
    const snap = this.metrics.snapshot();

    if (snap.p99Ms !== null) {
      if (snap.p99Ms > BREAKER.THRESHOLDS.P99_MS) {
        if (this.lastEvaluatedP99 !== snap.p99Ms) {
          this.p99Streak++;
          this.lastEvaluatedP99 = snap.p99Ms;
        }
        if (this.p99Streak >= BREAKER.SUSTAINED_WINDOWS) {
          this.trip();
        }
      } else {
        this.p99Streak = 0;
        this.lastEvaluatedP99 = snap.p99Ms;
      }
    }
  }

  recordUnavailable(): void {
    this.metrics.record("unavailable");
    this.checkRateThresholds();
  }

  recordViolation(): void {
    if (this.state() === "half_open") {
      this.trip();
      return;
    }
    this.metrics.record("violation");
    this.checkRateThresholds();
  }

  recordTimeout(): void {
    if (this.state() === "half_open") {
      this.trip();
      return;
    }
    this.metrics.record("timeout");
    this.checkRateThresholds();
  }

  recordPiiDetected(): void {
    if (this.state() === "half_open") {
      this.trip();
      return;
    }
    this.metrics.record("pii_detected");
    this.checkRateThresholds();
  }

  private checkRateThresholds(): void {
    const snap = this.metrics.snapshot();
    const total =
      snap.counts.accepted +
      snap.counts.unavailable +
      snap.counts.violation +
      snap.counts.timeout +
      snap.counts.pii_detected;

    if (total === 0) return;

    const violationDenom = total - snap.counts.unavailable;
    if (
      violationDenom > 0 &&
      snap.counts.violation / violationDenom > BREAKER.THRESHOLDS.VIOLATION_RATE
    ) {
      this.trip();
      return;
    }

    if (snap.counts.timeout / total > BREAKER.THRESHOLDS.TIMEOUT_RATE) {
      this.trip();
      return;
    }

    if (snap.counts.pii_detected / total > BREAKER.THRESHOLDS.PII_RATE) {
      this.trip();
      return;
    }
  }
}
