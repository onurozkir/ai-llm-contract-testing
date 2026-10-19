/**
 * Suggestion service orchestration.
 * Coordinates ticket context, PII masking, client deadline budgets, retry policies,
 * contract parsing, PII output detection, and circuit breaker metrics.
 */
import { BUDGETS } from "./config.js";
import { maskPii, detectPii } from "./pii.js";
import { parseContract, toDomain } from "./contract.js";
import { postSuggestionRequest, type TransportResult } from "./llmClient.js";
import type { Suggestion } from "./domain.js";
import type { Ticket } from "./tickets.js";
import type { CircuitBreaker, Metrics } from "./metrics.js";

export type NoSuggestionReason =
  | "flag_off"
  | "circuit_open"
  | "unavailable"
  | "timeout"
  | "contract_violation"
  | "pii_detected"
  | "provider_error";

export type SuggestionResult =
  | { status: "suggestion"; suggestion: Suggestion; elapsedMs: number }
  | { status: "unavailable"; reason: NoSuggestionReason; elapsedMs: number };

/**
 * Orchestrates requesting an LLM reply suggestion for a ticket.
 */
export async function suggest(
  ticket: Ticket,
  providerUrl: string,
  deps: {
    flagEnabled: boolean;
    breaker: CircuitBreaker;
    metrics: Metrics;
    deadlineMs?: number;
  }
): Promise<SuggestionResult> {
  const startTime = performance.now();

  // 1. Feature flag check (no HTTP call if disabled)
  if (!deps.flagEnabled) {
    return {
      status: "unavailable",
      reason: "flag_off",
      elapsedMs: Math.round(performance.now() - startTime),
    };
  }

  // 2. Circuit breaker check (no HTTP call if circuit is open)
  if (!deps.breaker.allowCall()) {
    return {
      status: "unavailable",
      reason: "circuit_open",
      elapsedMs: Math.round(performance.now() - startTime),
    };
  }

  // 3. Outbound request payload minimization with PII masking
  const outboundPayload = {
    subject: maskPii(ticket.subject),
    body: maskPii(ticket.body),
    category: ticket.category,
  };
  const bodyString = JSON.stringify(outboundPayload);

  const callDeadline = deps.deadlineMs ?? BUDGETS.LLM_CALL_MS;

  let transport: TransportResult | null = null;
  let attempts = 0;

  // 4. Transport loop with budget check & single retry on http_5xx
  while (attempts < 2) {
    attempts++;
    const elapsedSoFar = performance.now() - startTime;
    const remainingBudget = BUDGETS.TOTAL_MS - elapsedSoFar;
    if (remainingBudget <= 0) {
      break;
    }
    const currentDeadline = Math.min(callDeadline, remainingBudget);

    transport = await postSuggestionRequest(
      providerUrl,
      bodyString,
      currentDeadline
    );

    if (transport.ok) {
      break;
    }

    if (transport.reason === "http_5xx") {
      const postAttemptElapsed = performance.now() - startTime;
      if (attempts < 2 && BUDGETS.TOTAL_MS - postAttemptElapsed > 0) {
        continue;
      }
    }

    // No retry for timeout, 4xx, network, or schema/pii violations
    break;
  }

  const totalElapsedMs = Math.round(performance.now() - startTime);

  // 5. Handle transport errors
  if (!transport || !transport.ok) {
    if (transport?.reason === "timeout") {
      deps.breaker.recordTimeout();
      deps.metrics.record("timeout");
      return {
        status: "unavailable",
        reason: "timeout",
        elapsedMs: totalElapsedMs,
      };
    }

    return {
      status: "unavailable",
      reason: "provider_error",
      elapsedMs: totalElapsedMs,
    };
  }

  // 6. Contract boundary layer (parse -> version gate -> strict Zod)
  const contractOutcome = parseContract(transport.text);
  if (contractOutcome.kind === "violation") {
    deps.breaker.recordViolation();
    deps.metrics.record("violation", totalElapsedMs);
    return {
      status: "unavailable",
      reason: "contract_violation",
      elapsedMs: totalElapsedMs,
    };
  }

  // 7. Domain mapping
  const domainSuggestion = toDomain(contractOutcome.payload);
  if (!domainSuggestion) {
    deps.breaker.recordUnavailable();
    deps.metrics.record("unavailable", totalElapsedMs);
    return {
      status: "unavailable",
      reason: "unavailable",
      elapsedMs: totalElapsedMs,
    };
  }

  // 8. Output PII detection (cross-contamination guard)
  const piiHits = [
    ...detectPii(domainSuggestion.subject),
    ...detectPii(domainSuggestion.body),
  ];
  if (piiHits.length > 0) {
    deps.breaker.recordPiiDetected();
    deps.metrics.record("pii_detected", totalElapsedMs);
    return {
      status: "unavailable",
      reason: "pii_detected",
      elapsedMs: totalElapsedMs,
    };
  }

  // 9. Valid suggestion accepted
  deps.breaker.recordAccepted(totalElapsedMs);
  deps.metrics.record("accepted", totalElapsedMs);

  return {
    status: "suggestion",
    suggestion: domainSuggestion,
    elapsedMs: totalElapsedMs,
  };
}

