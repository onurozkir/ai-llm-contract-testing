# LLM Reply Suggestion (Contract-Driven) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a small, runnable Node.js/TypeScript demo that adds an LLM-backed reply suggestion to a deterministic ticket backend, with a validated zero-trust contract, deadline budgets, PII rules, and metric-driven kill conditions — plus blog drafts (TR/EN).

**Architecture:** Rules-based ticket flow (deterministic, never awaits the LLM) + an opt-in suggestion service. Mock LLM provider is a local HTTP server (no real LLM, ever). Raw provider output crosses three layers only: transport (client, 2200 ms hard deadline via AbortController) → contract (parse → version gate → strict Zod → domain mapping) → domain (`Suggestion`). A suggestion orchestrator applies budget-aware retry, PII scan, feature flag, and a circuit breaker fed by in-memory metrics.

**Tech Stack:** Node ≥ 20, TypeScript (strict), zod ^3, vitest ^2, tsx ^4. No other dependencies.

**Spec:** `docs/superpowers/specs/2026-10-19-llm-reply-suggestion-design.md`

## Global Constraints

- Node ≥ 20; code must run on Windows (PowerShell-friendly npm scripts).
- Dependencies only: `zod@^3`, dev deps `vitest@^2`, `typescript@^5`, `tsx@^4`, `@types/node@^20`.
- All code, comments, CLI output, and README in English. Blog drafts: `blog/tr.md` + `blog/en.md`, conversational tone, identical claims.
- No real network outside `127.0.0.1`. No real LLM anywhere.
- Exact budget values: `TOTAL 3000`, LLM call deadline `2200`. Breaker thresholds: violation rate `>0.10`, timeout rate `>0.50`, PII rate `>0.10`, p99 `>2200` sustained over **2 consecutive event-triggered evaluations**, window size `20`, open duration `60_000 ms`.
- Reason-code strings are exact (tests pin them): violations `parse_error | schema_violation | version_mismatch`; no-suggestion `flag_off | circuit_open | unavailable | timeout | contract_violation | pii_detected | provider_error`.
- `status:"unavailable"` is a valid contract state; it never counts as a violation.
- Timed-out calls are excluded from the latency distribution; `unavailable` excluded from the violation denominator.
- Log/metric events carry counts and reason codes only — **never** reply bodies or customer data.
- Domain types live in `src/domain.ts` and import nothing from zod/contract; only `src/contract.ts` maps DTO → domain.

## Review Focus

Failure modes the spec implies but no task's happy path exercises:

1. Empty-string reply fields (`subject:""`) — must be rejected by schema, not accepted and rendered blank. → Pinned in Task 3 (`rejects empty subject`).
2. Boundary confidences `0` and `1` — must be accepted (inclusive range), not off-by-one rejected. → Pinned in Task 3.
3. Provider request leaking raw customer PII — the outbound request body must contain only masked text. → Pinned in Task 8 (`sends masked request only`).
4. Non-JSON body with 200 status (e.g. HTML error page) — must surface as `parse_error`, not crash. → Pinned in Task 3.
5. Ticket mutated while a suggestion is in flight (staleness/stale-suggestion guard) — **known unproven gap, by partner decision**: blog theory only, no demo test (keep the review note: never wire a late suggestion into a stale ticket).

---

### Task 1: Project scaffold + config constants

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`
- Create: `src/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Produces: `BUDGETS` and `BREAKER` constants used by every later task:
  ```ts
  // src/config.ts
  export const BUDGETS = { TOTAL_MS: 3000, LLM_CALL_MS: 2200 } as const;
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
  ```

- [ ] **Step 1: Write the failing test** `tests/config.test.ts` asserting the exact values above (each constant, one expect each).
- [ ] **Step 2: Run** `npm test` → FAIL ("Cannot find module '../src/config'" or no test script yet).
- [ ] **Step 3: Scaffold** `package.json` (name `llm-contract-testing`, scripts: `test: "vitest run"`, `demo: "tsx demo/cli.ts"`, `typecheck: "tsc --noEmit"`), strict `tsconfig.json` (`target: ES2022`, `module: NodeNext`, `strict: true`, outDir `dist`), `vitest.config.ts` including `tests/`, `.gitignore` (`node_modules/`, `dist/`, `.superpowers/`). Run `npm install`. Implement `src/config.ts` exactly as the interface block.
- [ ] **Step 4: Run** `npm test` → PASS (config test green).
- [ ] **Step 5:** `git init`, commit: `chore: scaffold project with budget and breaker config`

### Task 2: PII masking & detection

**Files:**
- Create: `src/pii.ts`
- Test: `tests/pii.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export type PiiCategory = "phone" | "email" | "national_id";
  export function detectPii(text: string): PiiCategory[];  // categories found, order: phone, email, national_id
  export function maskPii(text: string): string;           // replaces each hit with "[masked-<category>]"
  ```
  Patterns (exact): email `/\b[\w.+-]+@[\w-]+\.[\w.]+\b/`; national_id `/\b\d{11}\b/`; phone `/\b(?:\+?90|0)?[\s.-]?\d{3}[\s.-]?\d{3}[\s.-]?\d{2}[\s.-]?\d{2}\b/`.

- [ ] **Step 1: Failing tests** — `"call me at 0532 123 45 67 or a@b.com.tr"` detects `["phone","email"]`; `"12345678901"` detects `["national_id"]`; `"regular text"` detects `[]`; `maskPii` output has no original digits/emailsegment and contains `[masked-phone]` and `[masked-email]`, with surrounding prose intact.
- [ ] **Step 2: Run** `npx vitest run tests/pii.test.ts` → FAIL.
- [ ] **Step 3: Implement** `src/pii.ts` from the patterns above.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: add PII detection and masking`

### Task 3: Contract layer (schema, version gate, domain mapping)

**Files:**
- Create: `src/domain.ts`, `src/contract.ts`
- Test: `tests/contract.test.ts`

**Interfaces:**
- Consumes: nothing (only zod).
- Produces:
  ```ts
  // src/domain.ts — no zod import allowed here
  export type Suggestion = { suggestionId: string; subject: string; body: string; confidence: number | null };

  // src/contract.ts
  export const CONTRACT_VERSION = 1;
  export type ViolationReason = "parse_error" | "schema_violation" | "version_mismatch";
  export type ContractOutcome =
    | { kind: "valid"; payload: ProviderPayload }
    | { kind: "violation"; reason: ViolationReason; detail: string };
  export function parseContract(rawText: string): ContractOutcome;   // JSON.parse → version gate → strict zod
  export function toDomain(payload: ProviderPayload): Suggestion | null; // null only when status==="unavailable"
  ```
  `providerResponseSchema` (internal but type-exported as `ProviderPayload = z.infer<...>`, exact shape): `contract_version: z.literal(1)`, `suggestion_id: z.string().uuid()`, `status: z.enum(["suggestion","unavailable"])`, `reply: z.object({ subject: z.string().min(1).max(200), body: z.string().min(1).max(4000) }).nullable()`, `confidence: z.number().min(0).max(1).nullable()`, `metadata: z.object({ model: z.string().min(1), generated_at: z.string().datetime(), latency_ms: z.number().int().nonnegative() })`; `.strict()`; plus `.refine((p) => (p.status === "suggestion") === (p.reply !== null))`.

- [ ] **Step 1: Failing tests** (each scenario = one test):
  - valid suggestion payload (uuid + reply + confidence 0.7) → `valid`; `confidence: 0` and `: 1` also `valid` (Review Focus 2).
  - `status:"unavailable"` + `reply:null` → `valid`; `toDomain` returns `null`.
  - `status:"suggestion"` + `reply:null` → `schema_violation`; same with `reply` present on unavailable.
  - `subject:""` → `schema_violation` (Review Focus 1).
  - `confidence: 1.5` or absent `metadata` → `schema_violation`; unknown top-level field → `schema_violation`.
  - body text `contract_version: 2` → `version_mismatch` (checked **before** schema).
  - 200-with-HTML body `"<html>oops</html>"` and body `"not json"` → `parse_error` (Review Focus 4).
  - `toDomain(valid)` maps `suggestion_id → suggestionId`, preserves subject/body/confidence.
- [ ] **Step 2: Run** `npx vitest run tests/contract.test.ts` → FAIL.
- [ ] **Step 3: Implement** `src/domain.ts` and `src/contract.ts`; order inside `parseContract`: JSON.parse (catch → `parse_error`) → `contract_version !== 1` → `version_mismatch` → schema.parse (catch → `schema_violation`).
- [ ] **Step 4: Run** → PASS. Also `npm run typecheck` → clean.
- [ ] **Step 5: Commit** `feat: add strict provider contract with version gate and domain mapping`

### Task 4: Mock LLM provider (local HTTP server)

**Files:**
- Create: `src/provider.ts`
- Test: `tests/provider.test.ts`

**Interfaces:**
- Consumes: contract field names (fixtures only, as plain objects — the provider is the "other side", it does not import zod).
- Produces:
  ```ts
  export type ProviderMode =
    | "valid" | "unavailable" | "malformed_json" | "wrong_type" | "unknown_field"
    | "version_2" | "pii_body" | "slow" | "flaky_500" | "always_500";
  export type MockProvider = { url: string; mode: ProviderMode; lastRequestBody: string | null; close(): Promise<void> };
  export async function startMockProvider(mode: ProviderMode): Promise<MockProvider>; // 127.0.0.1, port 0 (ephemeral)
  export function validFixture(): Record<string, unknown>; // the canonical valid payload (uuid fixed string, confidence 0.72, model "mock-gpt-1")
  ```
  Response bodies per mode: `valid`/`unavailable` → fixture variants (unavailable with `reply:null`); `malformed_json` → `"not json at all"`; `wrong_type` → fixture with `confidence:"high"`; `unknown_field` → fixture + `"sentiment":"positive"`; `version_2` → fixture version 2; `pii_body` → fixture whose reply.body contains `"0532 123 45 67"`; `slow` → fixture after **2600** ms; `flaky_500` → first request `500`, second valid; `always_500` → always `500`. All responses `Content-Type: application/json` (except `malformed_json`, which is `text/plain`).

- [ ] **Step 1: Failing tests** — for each mode, start server, `fetch(url)` once (twice for flaky), assert status and body matches the mode's description above (assert `version_2` body contains `"contract_version":2`; `pii_body` body contains the phone string). Assert `lastRequestBody` captured for a POST.
- [ ] **Step 2: Run** `npx vitest run tests/provider.test.ts` → FAIL.
- [ ] **Step 3: Implement** with `node:http`, port 0, deterministic fixture strings (fixed UUID, `generated_at` fixed ISO string so tests are stable).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: add mock LLM provider with failure-mode fixtures`

### Task 5: Transport client with hard deadline

**Files:**
- Create: `src/llmClient.ts`
- Test: `tests/llmClient.test.ts`

**Interfaces:**
- Consumes: `startMockProvider` (Task 4).
- Produces:
  ```ts
  export type TransportResult =
    | { ok: true; text: string; elapsedMs: number }
    | { ok: false; reason: "timeout" | "http_5xx" | "http_4xx" | "network"; status?: number; elapsedMs: number };
  export async function postSuggestionRequest(
    url: string, body: string, deadlineMs: number
  ): Promise<TransportResult>; // POST, Content-Type application/json, AbortController at deadlineMs
  ```

- [ ] **Step 1: Failing tests** (deadlineMs injectable so tests stay fast):
  - valid provider, deadline 1000 → `ok:true`, text parses to fixture.
  - `slow` provider, deadline 200 → `ok:false, reason:"timeout"`, and elapsed < 1000 (abort actually fired).
  - `always_500`, deadline 1000 → `reason:"http_5xx", status:500`.
  - unreachable port (start a server, close it, use its url) → `reason:"network"`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `src/llmClient.ts` (AbortController + `setTimeout`; clear the timer in `finally`).
- [ ] **Step 4: Run** → PASS; `npm run typecheck` clean.
- [ ] **Step 5: Commit** `feat: add deadline-enforcing transport client`

### Task 6: Metrics window + circuit breaker

**Files:**
- Create: `src/metrics.ts`
- Test: `tests/metrics.test.ts`

**Interfaces:**
- Consumes: `BREAKER`/`BUDGETS` (Task 1).
- Produces:
  ```ts
  export type CallOutcome = "accepted" | "unavailable" | "violation" | "timeout" | "pii_detected";
  export type WindowSnapshot = {
    counts: Record<CallOutcome, number>;  // within rolling window of last BREAKER.WINDOW_SIZE outcomes
    p99Ms: number | null;                 // from latency samples; timeouts recorded WITHOUT latencyMs are excluded
  };
  export class Metrics {
    record(outcome: CallOutcome, latencyMs?: number): void;
    snapshot(): WindowSnapshot;
  }
  export function evaluateWindow(snap: WindowSnapshot): boolean; // pure: true = should open
  export class CircuitBreaker {
    constructor(now?: () => number)
    allowCall(): boolean;                          // false while open (after OPEN_MS: one half-open probe allowed)
    state(): "closed" | "open" | "half_open";
    recordAccepted(latencyMs: number): void;
    recordUnavailable(): void;
    recordViolation(): void;
    recordTimeout(): void;
    recordPiiDetected(): void;
  }
  ```
  `evaluateWindow` rules (exact): total = sum of counts; total>0 and violation/total > 0.10 → true; timeout/total > 0.50 → true; pii_detected/total > 0.10 → true; p99Ms > 2200 (non-null) → true (sustained handling is the breaker's streak, below).

- [ ] **Step 1: Failing tests:**
  - window eviction: 25 recorded events keep only last 20 in counts.
  - `unavailable` alone never opens: snapshot with 5 `unavailable`, no violations/timeouts/pii, p99 `null` → `evaluateWindow` false.
  - violation denominator excludes `unavailable`: 3 `unavailable` + 2 `violation` → violation rate 2/(5−3)=1.0 > 0.10 → `evaluateWindow` true.
  - timeouts excluded from `p99Ms`: record 3 timeouts (no latency) + 1 accepted @100 ms → p99Ms === 100.
  - thresholds: 3 violations of 10 total → open signal; 9 timeouts of 12 → open; 2 pii of 10 → open; 2 violations of 100 → closed.
  - CircuitBreaker opens after: 3 violations of 3 (rate 1.0 > 0.10) in fresh breaker.
  - p99 sustained streak: `recordAccepted(2300)` ×3 → still closed (streak 1); ×2 more @2400 → open (2 consecutive event-triggered evaluations above 2200). Mixing low latencies after (@100 ×3) resets streak → closed again.
  - recovery: open breaker + fake `now` advanced 61 s → `state()==="half_open"`, `allowCall()` true once, second immediate call false; a recorded accept closes it.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `src/metrics.ts` (ring buffer of outcomes + latency samples for the same window; streak counter in breaker; half-open single-probe).
- [ ] **Step 4: Run** → PASS; typecheck clean.
- [ ] **Step 5: Commit** `feat: add rolling metrics and circuit breaker with kill thresholds`

### Task 7: Deterministic ticket flow + fallback suggestions

**Files:**
- Create: `src/tickets.ts`
- Test: `tests/tickets.test.ts`

**Interfaces:**
- Consumes: `Suggestion` (Task 3 domain).
- Produces:
  ```ts
  export type Ticket = {
    id: string; version: number;
    subject: string; body: string;                       // deliberately PII-ish customer text
    category: "refund" | "shipping" | "general";
  }
  export class TicketStore {
    seed(): void;                                        // two tickets: refund + general, e.g. "Order 8817 hasn't arrived, call 0532 123 45 67"
    get(id: string): Ticket;
    bumpVersion(id: string): number;
  }
  export function deterministicSuggestion(ticket: Ticket): Suggestion; // per-category canned template; confidence null; suggestionId = `${ticket.id}-d${ticket.version}`
  ```
  Fallback rule: never echo customer PII; the template references masked-safe text only.

- [ ] **Step 1: Failing tests** — seed/get returns tickets; `deterministicSuggestion` per category differs and never contains `"0532 123 45 67"` or the seeded email; `bumpVersion` increments and changes the `suggestionId`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `src/tickets.ts`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: add deterministic ticket store and rule-based fallback suggestions`

### Task 8: Suggestion service orchestration (budget, retry, PII, flag, breaker)

**Files:**
- Create: `src/suggestionService.ts`
- Test: `tests/suggestionService.test.ts`

**Interfaces:**
- Consumes: all previous tasks (`BUDGETS`, `pii`, contract, client, provider, metrics/breaker, tickets).
- Produces:
  ```ts
  export type NoSuggestionReason =
    | "flag_off" | "circuit_open" | "unavailable" | "timeout"
    | "contract_violation" | "pii_detected" | "provider_error";
  export type SuggestionResult =
    | { status: "suggestion"; suggestion: Suggestion; elapsedMs: number }
    | { status: "unavailable"; reason: NoSuggestionReason; elapsedMs: number };
  export async function suggest(
    ticket: Ticket, providerUrl: string,
    deps: { flagEnabled: boolean; breaker: CircuitBreaker; metrics: Metrics }
  ): Promise<SuggestionResult>;
  ```
  Behavior (exact): flag off → `flag_off` (no HTTP call — assert via provider.lastRequestBody === null); breaker closed → no call; builds request body `{subject, body, category}` with **maskPii** applied to subject and body; transport via `postSuggestionRequest(url, body, BUDGETS.LLM_CALL_MS)`; retry: only if transport reason is `http_5xx` AND remaining budget (>0 ms) allows — max 2 total attempts; transport timeout → `timeout`; transport network/http_4xx after retries → `provider_error`; contract violation → `contract_violation` (no retry); contract `valid` → PII scan body with `detectPii` → hit → `pii_detected` (no retry); `unavailable` → reason `unavailable`; success → record breaker `recordAccepted(elapsed)`, overtakes the deterministic suggestion at display time only.

- [ ] **Step 1: Failing tests** (each line = one test, real providers at real ports, deadlineMs via BUDGETS except where noted):
  - `valid` → `status:"suggestion"`, subject/body from fixture.
  - `unavailable` → reason `unavailable`.
  - `malformed_json`, `wrong_type`, `unknown_field`, `version_2` → reason `contract_violation`, and breaker `recordViolation` counted (snapshot counts.violation ≥ 1); no second attempt (provider request count check via `lastRequestBody` only — assert elapsed < one retry would take by using `always_500`+deadline instead where stated).
  - `pii_body` → reason `pii_detected`.
  - `slow` (deadline via BUDGETS.LLM_CALL_MS) → reason `timeout`, result arrives ≤ 2300 ms wall clock.
  - `flaky_500` → succeeds on attempt 2 (`status:"suggestion"`); `always_500` with deadline 200 → reason `provider_error` and two attempts proven by `elapsedMs ≥ 380` (two sequential 200 ms deadlines).
  - `flagEnabled:false` with `valid` provider → reason `flag_off`, `lastRequestBody === null`.
  - circuit open (pre-fed breaker: 3× `recordViolation()`) with `valid` provider → reason `circuit_open`, no HTTP call.
  - **masked request** (Review Focus 3): with `valid` provider and seeded ticket, `lastRequestBody` contains `"[masked-email]"`/`"[masked-phone]"` and does NOT contain the raw `0532 123 45 67` or seeded email before masking substring `@`.
  - metrics/breaker integration: 3 sequential calls to `malformed_json` provider → `breaker.state() === "open"`.
- [ ] **Step 2: Run** `npx vitest run tests/suggestionService.test.ts` → FAIL.
- [ ] **Step 3: Implement** `src/suggestionService.ts` following the behavior list exactly (single attempt loop with remaining-budget check; no AbortController handling here — Task 5 owns the deadline).
- [ ] **Step 4: Run** → PASS; run whole suite `npm test` → all green; typecheck clean.
- [ ] **Step 5: Commit** `feat: add suggestion service with flag, breaker, retry and PII rules`

### Task 9: Agent-screen CLI demo

**Files:**
- Create: `demo/cli.ts`
- Test: `tests/demo.test.ts`

**Interfaces:**
- Consumes: `suggest`, `TicketStore`, `startMockProvider`, `Metrics`.
- Produces:
  ```ts
  export async function runScenario(mode: ProviderMode, opts?: { flagEnabled?: boolean }): Promise<string[]>;
  // per scenario: starts provider, seeded ticket, fresh metrics+breaker, one suggest() call,
  // returns display lines, then closes provider.
  ```
  Line contract (exact, English): ticket line first — `"[ticket] <id> v<version> — deterministic suggestion ready in <ms>ms"` — then either `"[llm] suggestion accepted: <subject>"` or `"[llm] no suggestion (<reason>) — deterministic flow continued"`; final line `"[metrics] accepted=<> violations=<> timeouts=<> pii=<> p99=<ms>ms"`.

- [ ] **Step 1: Failing tests** — `runScenario("valid")` line array: first line matches `[ticket]`, second matches suggestion-accepted form and ends with the fixture subject; `runScenario("slow")` second line contains `(timeout)` and ticket line printed value < 50 (proves ticket flow never waited); `runScenario("pii_body")` contains `(pii_detected)`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `demo/cli.ts`; `npm run demo` entry: for each of `valid, unavailable, malformed_json, pii_body, slow, flaky_500` run a scenario sequentially, after all scenarios print the aggregated metrics snapshot and the breaker state; stdout English only.
- [ ] **Step 4: Run** `npm test` → PASS. Manually run `npm run demo` and eyeball output (README will document it).
- [ ] **Step 5: Commit** `feat: add agent-screen CLI demo with metrics summary`

### Task 10: README + blog drafts (TR/EN)

**Files:**
- Create: `README.md`, `blog/tr.md`, `blog/en.md`

**Interfaces:**
- Consumes: the finished code; every README/blog claim must be demonstrable by a test or a CLI run.

**Required structure (both blog files must cover all of):** ① problem statement (the original brief, paraphrased); ② the contract schema with the exact fields and the "unavailable is a valid state" argument; ③ boundary mapping ("parse, don't validate") with the anti-corruption layer; ④ the budget math including the 2200 ms argument and retry policy table (timeout 0 / 5xx 1 / violation 0); ⑤ PII & KVKK: masked input, output rejection, zero-content logs, retention proposal; ⑥ metrics + kill table incl. PII-rate condition and breaker parameters (exact numbers from `src/config.ts`); ⑦ rollout stages with **shadow mode explained theoretically**; ⑧ the staleness guard described **as theory, explicitly admitted as not proven by the demo**; ⑨ "when do we turn the LLM off?" answered plainly; ⑩ honest limits section (no real LLM, in-memory metrics, no persistence). Tone: conversational, first person, friend-to-friend; claims identical in TR and EN.

- [ ] **Step 1: Write** `README.md` — what it is, `npm install && npm test && npm run demo`, a file-to-decision map (each `src/` file ↔ which spec decision it proves), scenario list.
- [ ] **Step 2: Write** `blog/tr.md` then `blog/en.md` per the structure above.
- [ ] **Step 3: Verify by reading** each claim against the code and tests: any claim not backed by code or an explicit "not proven" admission gets fixed now. Run `npm run demo` once more and quote real output in both blog files.
- [ ] **Step 4: Commit** `docs: add README and TR/EN blog drafts`

---

## Self-Review Checklist (executed during planning)

- Spec coverage: budget decomposition (T1/T5/T8), strict contract+version gate (T3), anti-corruption mapping (T3), mock provider modes (T4), retry/fallback policy (T8), PII in/out/logs (T2/T3/T8), flag+breaker+metrics with exact thresholds (T1/T6/T8), deterministic flow never blocked (T7/T9), CLI demo (T9), README+blogs (T10). Shadow mode and staleness guard intentionally absent from code — blog theory only (T10), per partner decision.
- Step scan: every step has one unambiguous artifact; no "TBD" lines.
- Type consistency: reason codes, `Suggestion`, `TransportResult`, `CallOutcome` names match across Tasks 3/5/6/8/9.
- Review Focus: all five inputs pinned to owning tasks (Tasks 3, 3, 8, 3, and note 5 = admitted gap).
- Proportion: plan length ≈ spec length; bodies only where algorithms (breaker streak, parse order, CLI line contract) are not determined by signatures/tests.
