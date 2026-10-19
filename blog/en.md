# Integrating an LLM into a Deterministic Ticket System: A Contract-Driven Approach

The other day, I was talking with a teammate. They wanted to add an AI-assisted reply suggestion feature to our customer support dashboard. It's the classic pitch: a customer opens a ticket, and when the support agent views the screen, a language model presents a ready-to-send draft response. Sounds wonderful on paper, doesn't it?

Then we looked at the elephant in the room: What happens when the model hallucinates? What if it hangs for 5 seconds and freezes the agent's dashboard? What if it leaks one customer's phone number or ID into another customer's ticket? What if the provider's API suddenly updates its JSON shape without warning?

This post is the story of our engineering response to those exact questions. I'll walk through how we brought an LLM into production while rigorously protecting our deterministic world, using a clean, open-source reference implementation we built from scratch.

---

## 1. Problem Statement: The Fragile Guest in a Deterministic World

Our support backend is strictly deterministic: a ticket arrives, category-based canned rules instantly prepare a default response (0 milliseconds), and the agent moves forward without friction. It runs like clockwork.

LLMs, on the other hand, are inherently stochastic, high-latency, and unreliable. One day they return valid JSON; the next day they drop a closing bracket. Sometimes they respond in 400 milliseconds; sometimes they hang for 4 seconds.

Our non-negotiable rule was simple: **The LLM must never block the critical path.** When an agent opens a ticket, the deterministic fallback response must be on screen immediately. If the LLM call succeeds within budget, passes validation, and is clean of sensitive data, it gracefully replaces the fallback. If it fails or lags, nobody waits for it.

---

## 2. Zero-Trust Contract Schema and the "Unavailable" State

We treat responses from the LLM provider as untrusted user input from the wild. At the network boundary, we parse raw HTTP responses through a strict Zod contract:

```jsonc
{
  "contract_version": 1,               // Integer version; skew is rejected immediately
  "suggestion_id": "uuid",             // UUID for auditability and staleness checks
  "status": "suggestion" | "unavailable",
  "reply": {                           // Must be strictly null when status is "unavailable"
    "subject": "string, 1-200 chars",
    "body":    "string, 1-4000 chars"
  },
  "confidence": 0.0 - 1.0 | null,
  "metadata": {
    "model": "string",
    "generated_at": "ISO-8601 timestamp",
    "latency_ms": 42
  }
}
```

Here we made a fundamental architectural call:
**`status: "unavailable"` is not an error; it is a valid contract state.**

A model might recognize that a customer ticket lacks context and decide not to hallucinate a reply, returning `unavailable`. A silent model is a valid domain outcome, not a contract violation. Therefore, `unavailable` responses are excluded from the contract violation denominator and do not trip circuit breakers.

Furthermore, we enforce `.strict()`. If an unexpected field arrives (e.g. `"sentiment": "positive"`), the contract rejects it as a violation. Forward compatibility is handled deliberately via `contract_version`, never by silently accepting unknown payload shapes.

---

## 3. Boundary Mapping: "Parse, Don't Validate" and the Anti-Corruption Layer

Our core domain layer knows nothing about Zod schemas or provider DTOs. If you check `src/domain.ts`, you won't find a single Zod import:

```ts
export type Suggestion = {
  suggestionId: string;
  subject: string;
  body: string;
  confidence: number | null;
};
```

Data flows strictly across three boundaries:
1. **Network Boundary**: Raw text enters → `JSON.parse` (catches → `parse_error`) → Version gate (`contract_version !== 1` → `version_mismatch`) → Strict Zod validation (catches → `schema_violation`).
2. **Mapping Layer (Anti-Corruption)**: `toDomain()` takes the validated DTO, maps `suggestion_id` to camelCase `suggestionId`, and produces our domain model.
3. **Domain Layer**: The ticket workflow interacts exclusively with `Suggestion` or `NoSuggestion(reason)` objects.

---

## 4. Deadline Budget Math and Retry Policy

The end-user experience budget allows 3000 ms total. We decomposed this budget with clear intent:

```
TOTAL BUDGET: 3000 ms
  ├── LLM Call Hard Deadline = 2200 ms (Enforced via AbortController)
  ├── Validation & PII Scan   ≈  250 ms
  └── Transfer & Render       ≈  550 ms (Safety headroom)
```

Why 2200 ms? When you factor in network jitter, JSON parsing, regex scans, and UI rendering, an LLM call that takes longer than 2200 ms produces more user fatigue than assistance. In `src/llmClient.ts`, we attach an `AbortController` that aborts the HTTP request the moment 2200 ms elapses.

### Retry Policy

Blindly retrying AI requests is a recipe for cascading failures. We established a disciplined retry matrix:

| Failure Mode | Max Retries | Rationale |
|---|---|---|
| Timeout (`timeout`) | **0** | The budget is already exhausted; retrying would freeze the UI. |
| Transient Server Error (`http_5xx`) | **1** | Only attempted if remaining total budget allows (<3000 ms). |
| Contract Violation (`violation`) | **0** | Broken JSON or bad types indicate a systemic model bug; retrying produces the same invalid output. |
| PII Detected in Output | **0** | Output contamination requires immediate halting, not retries. |
| Model Silent (`unavailable`) | **0** | Not an error; no retry needed. |

---

## 5. PII & KVKK / GDPR Protection: What We Send, What We Store

Privacy compliance cannot be an afterthought. We instituted strict guardrails:

1. **Input Minimization & Masking**: Before outbound requests leave our boundary, `maskPii()` replaces phone numbers, email addresses, and national ID numbers with `[masked-phone]`, `[masked-email]`, and `[masked-national_id]`. Raw customer details never hit the provider.
2. **Output Scanning (Cross-Contamination Guard)**: When the model returns a suggestion, `detectPii()` scans the reply body. If unmasked personal data is found, the suggestion is immediately discarded under reason code `pii_detected`. The greatest danger is another customer's data leaking into this reply.
3. **Zero-Content Logging**: Our logs record outcome counters and reason codes (`accepted`, `timeout`, `circuit_open`, `pii_detected`) — **never customer messages or suggested reply text**.
4. **Retention**: Demo suggestions exist purely in-memory during request processing. In line with GDPR/KVKK purpose limitation, suggestions are not permanently persisted.

---

## 6. Metrics Window and Circuit Breaker

Every call is recorded in a rolling window of the last 20 events (`BREAKER.WINDOW_SIZE = 20`). Our kill conditions from `src/config.ts` are:

| Metric | Threshold | Action |
|---|---|---|
| Contract Violation Rate | **> 10%** | Trip Circuit Breaker (Open) |
| Timeout Rate | **> 50%** | Trip Circuit Breaker (Open) |
| PII Detection Rate | **> 10%** | Trip Circuit Breaker (Open) |
| p99 Latency | **> 2200 ms** (over 2 consecutive evaluations) | Trip Circuit Breaker (Open) |

When the breaker opens, the system stops calling the LLM entirely (`circuit_open`), saving network and compute costs. For 60 seconds (`BREAKER.OPEN_MS = 60_000`), all requests fall back to deterministic templates. After 60 seconds, the breaker enters `half_open` state and allows a single probe call. If that probe succeeds, normal operation resumes; if it fails, the breaker stays open for another 60 seconds.

---

## 7. Rollout Stages and Shadow Mode

Rolling out an LLM feature directly to all users is risky. A safe deployment follows three deliberate stages:

1. **Stage 1: Shadow Mode**: The system processes real customer tickets in the background. It masks input, queries the LLM, validates contracts, and tracks breaker metrics — **but never displays the suggestion to support agents**. This allows measuring latency, violation rates, and cost with zero operational risk.
2. **Stage 2: Internal Pilot**: The feature is enabled only for a small group of senior agents who provide qualitative feedback.
3. **Stage 3: Canary Rollout**: Traffic is progressively routed (10% → 50% → 100%) as long as circuit breaker metrics remain clean.

---

## 8. Staleness Guard: Theory and Known Limits

> **Honest Admission:** Because our demo focuses on isolated scenario execution, a race condition where a customer updates a ticket while an LLM call is in-flight is treated here as a theoretical architectural safeguard and is not proven by an automated test.

**The Theory:** A support agent views ticket version 1. The customer posts an update, bumping the ticket to version 2. If the LLM finishes generating a suggestion for version 1 and renders it, the agent might send advice addressing an outdated question.
**The Safeguard:** The suggestion payload contains `suggestionId: "${ticket.id}-d${ticket.version}"`. Before rendering, the frontend checks if the current ticket version matches. If a mismatch is detected, the stale suggestion is discarded.

---

## 9. When Do We Turn the LLM Off?

You shouldn't wait for customer complaints to disable a failing AI feature. The system pulls the plug automatically under four conditions:
1. **Violation rate exceeds 10%**: Indicates provider model regression or schema drift.
2. **PII detection rate exceeds 10%**: Indicates leakage or masking regex failure.
3. **Timeout rate exceeds 50%**: Indicates upstream provider outage or network degradation.
4. **Emergency Flag (`flagEnabled = false`)**: Instant manual kill-switch taking effect with 0 ms overhead.

In all four cases, the deterministic ticket engine continues running without missing a beat.

---

## 10. Real Output from the CLI Demo

Running `npm run demo` executes the test scenarios against our local mock provider:

```text
=== LLM Reply Suggestion Demo ===
Demonstrating zero-trust contract, hard deadline budgets, PII rules, and breaker metrics.

--- Scenario: mode="valid" ---
[ticket] t-refund v1 — deterministic suggestion ready in 0ms
[llm] suggestion accepted: Re: your invoice #4821
[metrics] accepted=1 violations=0 timeouts=0 pii=0 p99=15ms

--- Scenario: mode="unavailable" ---
[ticket] t-refund v1 — deterministic suggestion ready in 0ms
[llm] no suggestion (unavailable) — deterministic flow continued
[metrics] accepted=0 violations=0 timeouts=0 pii=0 p99=3ms

--- Scenario: mode="malformed_json" ---
[ticket] t-refund v1 — deterministic suggestion ready in 0ms
[llm] no suggestion (contract_violation) — deterministic flow continued
[metrics] accepted=0 violations=1 timeouts=0 pii=0 p99=2ms

--- Scenario: mode="pii_body" ---
[ticket] t-refund v1 — deterministic suggestion ready in 0ms
[llm] no suggestion (pii_detected) — deterministic flow continued
[metrics] accepted=0 violations=0 timeouts=0 pii=1 p99=2ms

--- Scenario: mode="slow" ---
[ticket] t-refund v1 — deterministic suggestion ready in 0ms
[llm] no suggestion (timeout) — deterministic flow continued
[metrics] accepted=0 violations=0 timeouts=1 pii=0 p99=none

--- Scenario: mode="flaky_500" ---
[ticket] t-refund v1 — deterministic suggestion ready in 0ms
[llm] suggestion accepted: Re: your invoice #4821
[metrics] accepted=1 violations=0 timeouts=0 pii=0 p99=4ms
```

Notice that in every single scenario, `deterministic suggestion ready in 0ms` is logged first. The deterministic path never waits for the LLM!

---

## 11. Honest Limitations

To keep our architecture transparent:
- **No Real LLM**: The test suite and demo run entirely against `src/provider.ts`, an in-memory Node HTTP server simulating 10 distinct failure modes (zero API costs, deterministic reproducibility).
- **In-Memory Metrics**: The rolling metrics window and circuit breaker operate in-memory. In a distributed multi-node production deployment, an external store like Redis would aggregate cluster-wide metrics.
- **In-Memory Storage**: Seeded tickets and fallback suggestions live in memory for demonstration purposes.

LLMs can unlock tremendous productivity, but without rigorous boundaries, they introduce unacceptable operational fragility. By enforcing zero-trust contracts, strict deadline budgets, and metric-driven circuit breakers, you get the best of both worlds: AI capability without compromising system reliability.

