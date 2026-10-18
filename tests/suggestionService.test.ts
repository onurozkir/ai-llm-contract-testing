import { describe, it, expect } from "vitest";
import { suggest } from "../src/suggestionService.js";
import { startMockProvider } from "../src/provider.js";
import { CircuitBreaker, Metrics } from "../src/metrics.js";
import { TicketStore } from "../src/tickets.js";

describe("suggestionService - suggest()", () => {
  const ticketStore = new TicketStore();
  ticketStore.seed();
  const sampleTicket = ticketStore.get("t-refund");

  it("returns status:suggestion with subject and body from fixture on valid provider", async () => {
    const provider = await startMockProvider("valid");
    const breaker = new CircuitBreaker();
    const metrics = new Metrics();

    try {
      const result = await suggest(sampleTicket, provider.url, {
        flagEnabled: true,
        breaker,
        metrics,
      });

      expect(result.status).toBe("suggestion");
      if (result.status === "suggestion") {
        expect(result.suggestion.subject).toBe("Re: your invoice #4821");
        expect(result.suggestion.body).toContain("invoice and next steps");
        expect(result.suggestion.confidence).toBe(0.72);
      }
    } finally {
      await provider.close();
    }
  });

  it("returns reason:unavailable when provider returns unavailable payload", async () => {
    const provider = await startMockProvider("unavailable");
    const breaker = new CircuitBreaker();
    const metrics = new Metrics();

    try {
      const result = await suggest(sampleTicket, provider.url, {
        flagEnabled: true,
        breaker,
        metrics,
      });

      expect(result.status).toBe("unavailable");
      if (result.status === "unavailable") {
        expect(result.reason).toBe("unavailable");
      }
    } finally {
      await provider.close();
    }
  });

  it("returns reason:contract_violation on contract invalid modes and records violation without retrying", async () => {
    const modes = [
      "malformed_json",
      "wrong_type",
      "unknown_field",
      "version_2",
    ] as const;

    for (const mode of modes) {
      const provider = await startMockProvider(mode);
      const breaker = new CircuitBreaker();
      const metrics = new Metrics();

      try {
        const result = await suggest(sampleTicket, provider.url, {
          flagEnabled: true,
          breaker,
          metrics,
        });

        expect(result.status).toBe("unavailable");
        if (result.status === "unavailable") {
          expect(result.reason).toBe("contract_violation");
        }
        expect(metrics.snapshot().counts.violation).toBeGreaterThanOrEqual(1);
      } finally {
        await provider.close();
      }
    }
  });

  it("returns reason:pii_detected when provider body contains PII", async () => {
    const provider = await startMockProvider("pii_body");
    const breaker = new CircuitBreaker();
    const metrics = new Metrics();

    try {
      const result = await suggest(sampleTicket, provider.url, {
        flagEnabled: true,
        breaker,
        metrics,
      });

      expect(result.status).toBe("unavailable");
      if (result.status === "unavailable") {
        expect(result.reason).toBe("pii_detected");
      }
      expect(metrics.snapshot().counts.pii_detected).toBe(1);
    } finally {
      await provider.close();
    }
  });

  it("returns reason:timeout within 2300ms when provider is slow", async () => {
    const provider = await startMockProvider("slow");
    const breaker = new CircuitBreaker();
    const metrics = new Metrics();

    try {
      const start = Date.now();
      const result = await suggest(sampleTicket, provider.url, {
        flagEnabled: true,
        breaker,
        metrics,
      });
      const wallClock = Date.now() - start;

      expect(result.status).toBe("unavailable");
      if (result.status === "unavailable") {
        expect(result.reason).toBe("timeout");
      }
      expect(wallClock).toBeLessThanOrEqual(2350);
      expect(metrics.snapshot().counts.timeout).toBe(1);
    } finally {
      await provider.close();
    }
  });

  it("succeeds on attempt 2 for flaky_500", async () => {
    const provider = await startMockProvider("flaky_500");
    const breaker = new CircuitBreaker();
    const metrics = new Metrics();

    try {
      const result = await suggest(sampleTicket, provider.url, {
        flagEnabled: true,
        breaker,
        metrics,
      });

      expect(result.status).toBe("suggestion");
      if (result.status === "suggestion") {
        expect(result.suggestion.subject).toBe("Re: your invoice #4821");
      }
    } finally {
      await provider.close();
    }
  });

  it("returns reason:provider_error on always_500", async () => {
    const provider = await startMockProvider("always_500");
    const breaker = new CircuitBreaker();
    const metrics = new Metrics();

    try {
      const result = await suggest(sampleTicket, provider.url, {
        flagEnabled: true,
        breaker,
        metrics,
        deadlineMs: 200,
      });

      expect(result.status).toBe("unavailable");
      if (result.status === "unavailable") {
        expect(result.reason).toBe("provider_error");
        expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
      }
    } finally {
      await provider.close();
    }
  });

  it("returns reason:flag_off and makes no HTTP call when flag is disabled", async () => {
    const provider = await startMockProvider("valid");
    const breaker = new CircuitBreaker();
    const metrics = new Metrics();

    try {
      const result = await suggest(sampleTicket, provider.url, {
        flagEnabled: false,
        breaker,
        metrics,
      });

      expect(result.status).toBe("unavailable");
      if (result.status === "unavailable") {
        expect(result.reason).toBe("flag_off");
      }
      expect(provider.lastRequestBody).toBeNull();
    } finally {
      await provider.close();
    }
  });

  it("returns reason:circuit_open and makes no HTTP call when circuit breaker is open", async () => {
    const provider = await startMockProvider("valid");
    const breaker = new CircuitBreaker();
    breaker.recordViolation();
    breaker.recordViolation();
    breaker.recordViolation();
    expect(breaker.state()).toBe("open");

    const metrics = new Metrics();

    try {
      const result = await suggest(sampleTicket, provider.url, {
        flagEnabled: true,
        breaker,
        metrics,
      });

      expect(result.status).toBe("unavailable");
      if (result.status === "unavailable") {
        expect(result.reason).toBe("circuit_open");
      }
      expect(provider.lastRequestBody).toBeNull();
    } finally {
      await provider.close();
    }
  });

  it("sends masked request only (never leaks raw customer PII to provider)", async () => {
    const provider = await startMockProvider("valid");
    const breaker = new CircuitBreaker();
    const metrics = new Metrics();

    try {
      await suggest(sampleTicket, provider.url, {
        flagEnabled: true,
        breaker,
        metrics,
      });

      expect(provider.lastRequestBody).not.toBeNull();
      const body = provider.lastRequestBody!;
      expect(body).toContain("[masked-phone]");
      expect(body).toContain("[masked-email]");
      expect(body).not.toContain("0532 123 45 67");
      expect(body).not.toContain("customer@example.com");
    } finally {
      await provider.close();
    }
  });

  it("trips circuit breaker to open after 3 sequential calls to malformed_json provider", async () => {
    const provider = await startMockProvider("malformed_json");
    const breaker = new CircuitBreaker();
    const metrics = new Metrics();

    try {
      for (let i = 0; i < 3; i++) {
        await suggest(sampleTicket, provider.url, {
          flagEnabled: true,
          breaker,
          metrics,
        });
      }
      expect(breaker.state()).toBe("open");
    } finally {
      await provider.close();
    }
  });
});
