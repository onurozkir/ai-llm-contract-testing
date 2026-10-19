import { describe, it, expect } from "vitest";
import {
  Metrics,
  evaluateWindow,
  CircuitBreaker,
  type WindowSnapshot,
} from "../src/metrics.js";

describe("Metrics", () => {
  it("keeps only the last 20 events in counts (eviction)", () => {
    const metrics = new Metrics();
    for (let i = 0; i < 25; i++) {
      metrics.record(i < 5 ? "violation" : "accepted", 50);
    }
    const snap = metrics.snapshot();
    const total =
      snap.counts.accepted +
      snap.counts.unavailable +
      snap.counts.violation +
      snap.counts.timeout +
      snap.counts.pii_detected;
    expect(total).toBe(20);
    expect(snap.counts.violation).toBe(0); // first 5 violations were evicted
    expect(snap.counts.accepted).toBe(20);
  });

  it("excludes timeouts without latency from p99Ms calculation", () => {
    const metrics = new Metrics();
    metrics.record("timeout");
    metrics.record("timeout");
    metrics.record("timeout");
    metrics.record("accepted", 100);

    const snap = metrics.snapshot();
    expect(snap.counts.timeout).toBe(3);
    expect(snap.counts.accepted).toBe(1);
    expect(snap.p99Ms).toBe(100);
  });
});

describe("evaluateWindow", () => {
  it("never opens on unavailable alone", () => {
    const snap: WindowSnapshot = {
      counts: {
        accepted: 0,
        unavailable: 5,
        violation: 0,
        timeout: 0,
        pii_detected: 0,
      },
      p99Ms: null,
    };
    expect(evaluateWindow(snap)).toBe(false);
  });

  it("excludes unavailable from the violation rate denominator", () => {
    const snap: WindowSnapshot = {
      counts: {
        accepted: 0,
        unavailable: 3,
        violation: 2,
        timeout: 0,
        pii_detected: 0,
      },
      p99Ms: null,
    };
    // violation rate = 2 / (5 - 3) = 1.0 > 0.10
    expect(evaluateWindow(snap)).toBe(true);
  });

  it("evaluates rate thresholds correctly", () => {
    // 3 violations of 10 total -> 0.30 > 0.10 -> open
    expect(
      evaluateWindow({
        counts: {
          accepted: 7,
          unavailable: 0,
          violation: 3,
          timeout: 0,
          pii_detected: 0,
        },
        p99Ms: 100,
      })
    ).toBe(true);

    // 9 timeouts of 12 total -> 0.75 > 0.50 -> open
    expect(
      evaluateWindow({
        counts: {
          accepted: 3,
          unavailable: 0,
          violation: 0,
          timeout: 9,
          pii_detected: 0,
        },
        p99Ms: 100,
      })
    ).toBe(true);

    // 2 pii of 10 total -> 0.20 > 0.10 -> open
    expect(
      evaluateWindow({
        counts: {
          accepted: 8,
          unavailable: 0,
          violation: 0,
          timeout: 0,
          pii_detected: 2,
        },
        p99Ms: 100,
      })
    ).toBe(true);

    // 2 violations of 100 total -> 0.02 <= 0.10 -> closed
    expect(
      evaluateWindow({
        counts: {
          accepted: 98,
          unavailable: 0,
          violation: 2,
          timeout: 0,
          pii_detected: 0,
        },
        p99Ms: 100,
      })
    ).toBe(false);
  });
});

describe("CircuitBreaker", () => {
  it("opens after 3 violations of 3 in a fresh breaker", () => {
    const breaker = new CircuitBreaker();
    expect(breaker.state()).toBe("closed");
    breaker.recordViolation();
    breaker.recordViolation();
    breaker.recordViolation();
    expect(breaker.state()).toBe("open");
    expect(breaker.allowCall()).toBe(false);
  });

  it("handles sustained p99 latency streak and resets on low latencies", () => {
    const breaker = new CircuitBreaker();
    // 3 calls @ 2300 ms -> streak 1 -> still closed
    breaker.recordAccepted(2300);
    breaker.recordAccepted(2300);
    breaker.recordAccepted(2300);
    expect(breaker.state()).toBe("closed");

    // 2 more @ 2400 ms -> streak 2 -> open
    breaker.recordAccepted(2400);
    breaker.recordAccepted(2400);
    expect(breaker.state()).toBe("open");

    // Fresh breaker: mixing low latencies resets streak
    const breaker2 = new CircuitBreaker();
    breaker2.recordAccepted(2300);
    breaker2.recordAccepted(2300);
    breaker2.recordAccepted(2300);
    expect(breaker2.state()).toBe("closed");

    breaker2.recordAccepted(100);
    breaker2.recordAccepted(100);
    breaker2.recordAccepted(100);
    expect(breaker2.state()).toBe("closed");

    // 1 more high latency after reset does not trip (needs 2 consecutive evaluations)
    breaker2.recordAccepted(2300);
    expect(breaker2.state()).toBe("closed");
  });

  it("handles recovery: half-open single probe then closes on accept", () => {
    let fakeNow = 1000;
    const breaker = new CircuitBreaker(() => fakeNow);

    breaker.recordViolation();
    expect(breaker.state()).toBe("open");
    expect(breaker.allowCall()).toBe(false);

    // Advance 61 seconds (past 60_000 ms OPEN_MS)
    fakeNow += 61_000;
    expect(breaker.state()).toBe("half_open");

    // First call allowed in half_open
    expect(breaker.allowCall()).toBe(true);
    // Second immediate call disallowed
    expect(breaker.allowCall()).toBe(false);

    // Recorded accept closes the breaker
    breaker.recordAccepted(50);
    expect(breaker.state()).toBe("closed");
    expect(breaker.allowCall()).toBe(true);
  });
});

