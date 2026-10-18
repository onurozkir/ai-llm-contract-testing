# Design: LLM-Backed Reply Suggestion, Added Safely to a Deterministic Backend

Date: 2026-10-19
Status: draft for approval

## Intent and why

A customer-support backend gets a new feature: an LLM generates a draft reply
for a support agent. The existing system is deterministic and must never break
because the suggestion layer misbehaves. We are not shipping a real LLM — we
are building a **small, demonstrable, contract-driven slice** that proves the
safety design, plus a **blog post** that explains and defends the design.

The demo and blog exist to answer one question, made concrete:

> How do you add an LLM feature to a production backend without ever letting
> the LLM break the deterministic flow — and how do you *prove* it before a
> real model is ever called?

Audience: (a) a technical reviewer who judges engineering judgment, and
(b) the broader developer community taking the idea into their own code.

## Goals

- A runnable Node.js/TypeScript demo small enough to read in one sitting.
- The **suggestion contract** between the LLM provider and our backend is
  explicit, versioned, and validated at the network boundary.
- Ticket lifecycle is provably independent of the LLM: slow, broken, or
  disabled suggestion service changes nothing about ticket flow.
- Deadline budget decomposition: total suggestion budget 3000 ms; the LLM
  call itself gets ≤2200 ms; the remainder covers validation, PII scan,
  transfer, and rendering.
- PII handling consistent with KVKK principles: minimization on input,
  scanning on output, zero content in logs, event-level metrics only.
- Metrics + kill conditions: contract-violation rate, timeout rate, p99 vs
  budget, PII detections; a circuit breaker and a global feature flag.
- Deterministic fallback suggestion is always available; a missing or
  rejected LLM suggestion is a normal state, not an error state.

## Non-goals

- No real LLM is called anywhere — the provider is a local mock HTTP server.
- No auto-send; suggestions are display-only.
- No persistent storage; everything is in-memory for the demo run.
- No shadow mode in the demo (discussed and deferred to the blog as theory).
- No staleness-guard scenario in the demo (discussed; deferred to the blog as
  theory — described there as `suggestion_id` + ticket-version check, with the
  explicit admission that the demo does not prove it).
- No queues, no workers, no real deployment story beyond the code reading.
## Anti-goals (failure even if it technically works)

- A reader cannot tell *why* a suggestion was rejected from logs/metrics.
- The ticket state machine ever `await`s the suggestion service.
- A test suite that hides the failure modes instead of demonstrating each.

## Deliverables

1. **Demo repo** (this directory), code and comments in English:
   - `src/` — deterministic ticket flow + suggestion service + contract
     layer + mock LLM provider + in-memory metrics.
   - Contract tests demonstrating each failure mode of the mock provider:
     valid response, `unavailable` status, malformed JSON, schema violation
     (wrong types / unknown fields), PII in body, slow response (>2200 ms),
     transient 5xx with retry, circuit-breaker opening and recovery.
   - A small CLI that plays the "agent screen" once per mock scenario, so a
     reader can watch the same ticket flow behave identically in every mode.
   - README (English) mapping each file to the design decision it proves.
2. **Blog draft**, both versions, conversational "friend-to-friend" tone:
   - `blog/tr.md` and `blog/en.md`, same structure and claims.
   - Covers: contract definition, schema validation trade-offs, deadline
     budget math (the 2200 ms call), retry/fallback policy, domain mapping
     ("parse, don't validate"), PII/KVKK rules, metrics and kill conditions,
     rollout stages (shadow mode stays **theoretical** here, per decision),
     and the explicit answer to "when do we turn the LLM off?"

## Decided (by the human partner)

- Stack: Node.js + TypeScript, Zod for schema validation, Vitest for tests.
- No real LLM call anywhere in demo or tests; only the mock provider.
- Demo stays slim; shadow mode is blog theory only.
- Blog shipped in Turkish and English; code in English.
- Core principles the design must honor (partner's words):
  1. The LLM must never block the ticket lifecycle's critical path.
  2. Mock/raw LLM output must not reach the domain directly — it must pass
     through a schema and explicit mapping.
  3. The 3000 ms UX budget must be decomposed; ~2200 ms goes to the LLM call
     so validation and transfer have room.
  4. PII/KVKK: decide what we send, what we show, what we log, what we keep.
  5. Definable, metric-driven conditions for disabling the LLM entirely.

## Decided in brainstorming (with partner's challenge incorporated)

### Contract schema (the partner asked: what does it look like?)

HTTP response from the LLM provider endpoint, validated with strict Zod:

```jsonc
{
  "contract_version": 1,               // integer, must be present
  "suggestion_id": "uuid",             // for staleness guards and audit
  "status": "suggestion" | "unavailable",
  "reply": {                          // null when status is "unavailable"
    "subject": "string, ≤200 chars",
    "body":    "string, ≤4000 chars"
  },
  "confidence": 0.0–1.0 | null,
  "metadata": {
    "model": "string",
    "generated_at": "ISO-8601 timestamp",
    "latency_ms": "integer"
  }
}
```

- Unknown fields are **rejected** in v1 (strictness → safety; forward
  compatibility is handled by `contract_version`, not by silently accepting).
- A `contract_version` **mismatch** (unknown/higher version) is a contract
  violation with its own reason code (`version_mismatch`), feeding the
  aggregate violation counter; the blog states that v1 treats version skew
  as rejection, not graceful negotiation. *(Builder check: settled as my call.)*
- `status: "unavailable"` is a **valid response** — a silent model is a
  contract state, not an error.

### Boundary and domain mapping (the partner asked: does mock output enter the domain raw?)

Three layers, nothing bypasses them:

1. **Network boundary**: raw body → `contract_version` check → Zod validate.
   Any failure = contract violation event, not a domain error.
2. **Mapping**: validated DTO → domain type `Suggestion` (own shape, own
   invariants). The domain layer never imports the DTO type.
3. **Domain**: ticket flow consumes `Suggestion | NoSuggestion(reason)`.

### Deadline budget (the partner's 2200 ms insight)

```
SUGGESTION_TOTAL_BUDGET_MS = 3000
  ├── LLM call deadline      = 2200   (AbortController; late = canceled)
  ├── validation + PII scan  ≈  250
  └── transfer + render      ≈  550   (headroom, kept as guardrail)
```

- The **enforced** mechanisms are the 2200 ms LLM deadline and the 3000 ms
  total guard; the sub-budgets are **advisory** — measured and printed in the
  metrics snapshot, not hard-enforced. *(Builder check: settled, demo stays
  slim.)*
- Late responses are **canceled**, not consumed; staleness is additionally
  guarded by `suggestion_id` + ticket version before display.
- **Retry policy** (a deliberate trade-off, argued in the blog):
  - timeout → 0 retries (no budget left),
  - transient HTTP 5xx → at most 1 retry, only if remaining budget allows,
  - schema/PII violation → 0 retries (systemic problem; retrying feeds the
    same broken output to more tickets),
  - `unavailable` → not an error; no retry.
- **Fallback**: deterministic suggestion always served first; the LLM
  suggestion, when valid, replaces it in the UI. A rejected/absent LLM
  suggestion is a normal state with a reason code.

### PII / KVKK (the partner asked: what protects the data?)

- **Input minimization**: the prompt sent to the provider contains masked
  data (regex masks for phone/email/national ID) — masking hurts suggestion
  quality and that trade-off is stated in the blog.
- **Output scan**: if the reply body contains PII patterns, the suggestion is
  **rejected**. Rationale: the dangerous case is cross-contamination —
  another customer's data leaking into this ticket.
- **Logs**: decision events only (`accepted | rejected:<reason> | timeout |
  circuit_open | flag_off | pii_detected`), with counts; **never** reply
  bodies or masked/raw customer data.
- **Retention**: demo is in-memory; the blog proposes suggestion TTL or
  "regenerate on demand, don't store" and names KVKK anchors: purpose
  limitation, data minimization, retention limits.

### Kill conditions (the partner asked: what metrics, when do we turn it off?)

Rolling window of the last ~20 calls:

| Metric | Threshold |
|---|---|
| Contract-violation rate | > 10% → open circuit |
| Timeout rate          | > 50% → open circuit |
| PII-detection rate | > 10% → open circuit (systemic detections implicate the input-masking layer) |
| p99 latency | > 2200 ms in **two consecutive windows** → open circuit |

Definitions *(builder check: settled as my calls)*:

- Malformed JSON, schema violations, and version mismatches all feed the
  **same aggregate contract-violation counter**; the log line separates them
  by reason code.
- `unavailable` is excluded from the violation denominator (valid state).
- Timed-out calls are excluded from the latency distribution (the timeout
  rate covers them); "p99" on a 20-sample window is effectively the max.
- PII-detection rate is a kill condition, observe-per-reason in logs.

- Open circuit = suggestions disabled for 60 s, deterministic flow unmoved,
  half-open probes to recover; plus a global kill-switch flag.
- Demo exposes an in-memory metrics snapshot printed at end of run.

## Left to the builder (my calls unless flagged)

- Mock provider = a plain Node `http` server started by tests and by the CLI,
  with a mode switch per scenario; no extra framework.
- CLI output in English; exit code reflects nothing (it's a demo).
- File layout and naming; trivial in-memory ticket store seeded with one or
  two example tickets with deliberately PII-ish fields to prove masking.
- Exact wording/structure of the README and blog drafts (tone: conversational
  in both TR and EN, technical claims identical).
- `contract_version` on the **request** side (request schema kept minimal:
  masked ticket context + instruction), argued briefly in the blog.

## Open questions for the partner

- None pending at approval time.

## Builder-check outcomes (post-review)

- Six questions raised; five settled as builder calls (version mismatch,
  PII kill condition, advisory sub-budgets, breaker metric definitions,
  aggregate violation counter — all marked inline above).
- One scoped by the partner: the staleness guard stays **blog theory only**,
  no demo/test scenario (see Non-goals).
