# Contract-Driven LLM Reply Suggestion

A production-grade, zero-trust implementation demonstrating how to add an LLM-backed reply suggestion feature to a deterministic ticket backend without sacrificing uptime, data privacy (KVKK/GDPR), or user experience.

---

## Key Principles

1. **The LLM never blocks the critical path**: Fallback suggestions are generated deterministically in milliseconds from category templates.
2. **Zero-trust boundary ("Parse, don't validate")**: Provider responses cross an anti-corruption layer (`parseContract` → `toDomain`). Domain types import no DTO schemas.
3. **Hard UX deadline budgets**: Total budget is 3000 ms. The LLM call has a hard 2200 ms deadline enforced via `AbortController`.
4. **Strict PII & KVKK hygiene**: Outbound requests are minimized and masked. Inbound suggestions with PII are rejected. Logs contain metrics only, never message bodies.
5. **Metric-driven kill conditions**: In-memory rolling metrics window (last 20 events) trips a circuit breaker on high violation rates (>10%), high timeout rates (>50%), high PII leakage (>10%), or sustained high p99 latency (>2200 ms).

---

## Quickstart

Requirements: Node.js ≥ 20.

```bash
# Install dependencies
npm install

# Run all automated tests (74 tests)
npm test

# Run TypeScript typecheck
npm run typecheck

# Run the agent-screen CLI demo
npm run demo

# Start the HTTP server for Postman testing
npm run server
```

---

## Testing with Postman

We have included a ready-to-import Postman Collection in the repository: [`postman_collection.json`](postman_collection.json).

1. Start the server:
   ```bash
   npm run server
   ```
   The API server will listen on `http://127.0.0.1:3000`.
2. Open **Postman**, click **Import**, and select or drag-and-drop `postman_collection.json`.
3. You will get 15 ready-to-run requests covering:
   - **Sample Tickets & Metrics Inspection**
   - **Scenario 1 to 10**: Testing each provider failure mode (`valid`, `unavailable`, `malformed_json`, `wrong_type`, `unknown_field`, `version_2`, `pii_body`, `slow`, `flaky_500`, `always_500`).
   - **Feature Flag Off**: Verifying 0ms fallback without network calls.
   - **Custom Ticket Testing**: Sending your own customer text to inspect request masking and response behavior.
   - **Circuit Breaker Reset**: Dynamically resetting the breaker.

---

## File-to-Decision Map

| File | Architectural Decision Proven |
|---|---|
| `src/config.ts` | Pinned budget constants (`TOTAL_MS: 3000`, `LLM_CALL_MS: 2200`) and breaker thresholds. |
| `src/pii.ts` | Outbound minimization and masking for phone, email, and national IDs (`[masked-<category>]`). |
| `src/domain.ts` | Pure domain model (`Suggestion`). Imports zero dependencies and zero DTO types. |
| `src/contract.ts` | Anti-corruption layer: JSON parsing → version gate (`contract_version === 1`) → strict Zod schema → domain mapping. `status: "unavailable"` is a first-class valid state. |
| `src/provider.ts` | Standalone mock LLM HTTP server (`127.0.0.1`, port 0) simulating 10 deterministic failure modes. |
| `src/llmClient.ts` | Transport client with strict `AbortController` deadline enforcement. |
| `src/metrics.ts` | Rolling 20-sample window and circuit breaker with sustained p99 tracking and half-open single-probe recovery. |
| `src/tickets.ts` | Deterministic ticket store seeded with customer PII; canned fallback suggestions that never echo PII. |
| `src/suggestionService.ts` | End-to-end orchestration: feature flag gate, circuit breaker check, request masking, 5xx retry with budget guard, contract parsing, output PII scan. |
| `demo/cli.ts` | CLI simulation demonstrating the agent screen experience across provider failure modes. |

---

## Provider Failure Modes & Scenarios

| Mode | Provider Response | System Reaction | Reason Code |
|---|---|---|---|
| `valid` | HTTP 200, valid JSON fixture | Suggestion accepted and displayed to agent | — |
| `unavailable` | HTTP 200, valid JSON with `status: "unavailable"` | Deterministic fallback served; treated as valid state (not a violation) | `unavailable` |
| `malformed_json` | HTTP 200, `"not json at all"` (`text/plain`) | Rejected at network boundary; violation counter incremented | `contract_violation` |
| `wrong_type` | HTTP 200, `confidence: "high"` (string instead of float) | Rejected by strict Zod schema; violation counter incremented | `contract_violation` |
| `unknown_field` | HTTP 200, fixture + extra `"sentiment": "positive"` | Rejected by strict Zod `.strict()` schema; forward-compat is managed via versioning | `contract_violation` |
| `version_2` | HTTP 200, `"contract_version": 2` | Rejected by version gate before schema evaluation | `contract_violation` |
| `pii_body` | HTTP 200, reply body embeds `"0532 123 45 67"` | Output scan triggers rejection (prevents cross-contamination) | `pii_detected` |
| `slow` | HTTP 200 after 2600 ms server delay | Aborted at 2200 ms deadline; deterministic fallback served | `timeout` |
| `flaky_500` | Attempt 1: HTTP 500; Attempt 2: HTTP 200 valid fixture | Transient 5xx retried within remaining budget; succeeds on attempt 2 | — |
| `always_500` | Every attempt: HTTP 500 | Retried once; returns provider error without crashing critical path | `provider_error` |