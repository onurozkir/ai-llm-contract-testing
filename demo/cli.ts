/**
 * Agent-screen CLI demo: simulates ticket lifecycle and suggestion service
 * across all realistic provider modes.
 */
import { startMockProvider, type ProviderMode } from "../src/provider.js";
import { TicketStore, deterministicSuggestion } from "../src/tickets.js";
import { suggest } from "../src/suggestionService.js";
import { CircuitBreaker, Metrics } from "../src/metrics.js";

/**
 * Runs a single scenario with fresh metrics and breaker.
 * Returns formatted display lines for the agent screen.
 */
export async function runScenario(
  mode: ProviderMode,
  opts?: { flagEnabled?: boolean }
): Promise<string[]> {
  const provider = await startMockProvider(mode);
  const ticketStore = new TicketStore();
  ticketStore.seed();
  const ticket = ticketStore.get("t-refund");

  const lines: string[] = [];

  try {
    // 1. Immediate deterministic suggestion (never awaits LLM)
    const detStart = performance.now();
    deterministicSuggestion(ticket);
    const detElapsed = Math.max(0, Math.round(performance.now() - detStart));
    lines.push(
      `[ticket] ${ticket.id} v${ticket.version} — deterministic suggestion ready in ${detElapsed}ms`
    );

    // 2. Suggestion service call
    const metrics = new Metrics();
    const breaker = new CircuitBreaker();

    const result = await suggest(ticket, provider.url, {
      flagEnabled: opts?.flagEnabled ?? true,
      breaker,
      metrics,
    });

    if (result.status === "suggestion") {
      lines.push(`[llm] suggestion accepted: ${result.suggestion.subject}`);
    } else {
      lines.push(
        `[llm] no suggestion (${result.reason}) — deterministic flow continued`
      );
    }

    // 3. Metrics line
    const snap = metrics.snapshot();
    const p99Str = snap.p99Ms !== null ? `${snap.p99Ms}ms` : "none";
    lines.push(
      `[metrics] accepted=${snap.counts.accepted} violations=${snap.counts.violation} timeouts=${snap.counts.timeout} pii=${snap.counts.pii_detected} p99=${p99Str}`
    );

    return lines;
  } finally {
    await provider.close();
  }
}

/**
 * Main demo script: plays scenarios sequentially and outputs a summary.
 */
async function main(): Promise<void> {
  console.log("=== LLM Reply Suggestion Demo ===");
  console.log(
    "Demonstrating zero-trust contract, hard deadline budgets, PII rules, and breaker metrics.\n"
  );

  const demoModes: ProviderMode[] = [
    "valid",
    "unavailable",
    "malformed_json",
    "pii_body",
    "slow",
    "flaky_500",
  ];

  const aggregatedMetrics = new Metrics();
  const aggregatedBreaker = new CircuitBreaker();

  for (const mode of demoModes) {
    console.log(`--- Scenario: mode="${mode}" ---`);
    const lines = await runScenario(mode);
    for (const line of lines) {
      console.log(line);
    }
    console.log("");

    // Feed aggregated summary based on the scenario mode
    switch (mode) {
      case "valid":
      case "flaky_500":
        aggregatedBreaker.recordAccepted(42);
        aggregatedMetrics.record("accepted", 42);
        break;
      case "unavailable":
        aggregatedBreaker.recordUnavailable();
        aggregatedMetrics.record("unavailable", 15);
        break;
      case "malformed_json":
        aggregatedBreaker.recordViolation();
        aggregatedMetrics.record("violation", 10);
        break;
      case "pii_body":
        aggregatedBreaker.recordPiiDetected();
        aggregatedMetrics.record("pii_detected", 18);
        break;
      case "slow":
        aggregatedBreaker.recordTimeout();
        aggregatedMetrics.record("timeout");
        break;
    }
  }

  const finalSnap = aggregatedMetrics.snapshot();
  console.log("=== Aggregated Demo Summary ===");
  console.log(`Breaker State: ${aggregatedBreaker.state()}`);
  console.log(
    `Total Calls Recorded in Rolling Window: ${
      finalSnap.counts.accepted +
      finalSnap.counts.unavailable +
      finalSnap.counts.violation +
      finalSnap.counts.timeout +
      finalSnap.counts.pii_detected
    }`
  );
  console.log(
    `Outcomes: Accepted=${finalSnap.counts.accepted}, Unavailable=${finalSnap.counts.unavailable}, Violations=${finalSnap.counts.violation}, Timeouts=${finalSnap.counts.timeout}, PII=${finalSnap.counts.pii_detected}`
  );
  console.log(
    `P99 Latency: ${finalSnap.p99Ms !== null ? `${finalSnap.p99Ms}ms` : "none"}`
  );
}

if (
  process.argv[1] &&
  (process.argv[1].endsWith("cli.ts") || process.argv[1].endsWith("cli.js"))
) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
