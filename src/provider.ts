/**
 * Mock LLM provider: a local HTTP server simulating a real provider across
 * 10 deterministic failure modes.
 *
 * The provider is the "other side" of the trust boundary: it serves plain
 * fixture objects as JSON and deliberately does NOT validate anything —
 * later contract tests rely on broken modes being rejected by
 * `parseContract`. Deterministic fixed values keep tests stable.
 */
import http from "node:http";

/** Failure-mode selector for the mock provider. */
export type ProviderMode =
  | "valid"
  | "unavailable"
  | "malformed_json"
  | "wrong_type"
  | "unknown_field"
  | "version_2"
  | "pii_body"
  | "slow"
  | "flaky_500"
  | "always_500";

/** Handle returned by `startMockProvider`; `close()` fully tears the server down. */
export type MockProvider = {
  url: string;
  mode: ProviderMode;
  lastRequestBody: string | null;
  close(): Promise<void>;
};

/** Fixed UUID string for the fixture (valid per the contract's uuid() rule). */
const FIXTURE_UUID = "123e4567-e89b-42d3-a456-426614174000";
/** Fixed ISO timestamp so test output is stable. */
const GENERATED_AT = "2026-10-19T09:30:00.000Z";
/** Fixed model name reported in fixture metadata. */
const MODEL = "mock-gpt-1";
/** The single fixed endpoint path served by every mock provider. */
const SUGGESTION_PATH = "/v1/suggest";
/** Pinned server-side delay for the slow mode (clients use a 2200 ms deadline). */
const SLOW_DELAY_MS = 2600;
/** Phone number embedded by the pii_body mode (the masking layer's raw input). */
const PII_PHONE = "0532 123 45 67";

/**
 * The canonical valid provider payload as a plain object — the provider side
 * never validates this against the contract.
 */
export function validFixture(): Record<string, unknown> {
  return {
    contract_version: 1,
    suggestion_id: FIXTURE_UUID,
    status: "suggestion",
    reply: {
      subject: "Re: your invoice #4821",
      body: "Hello! Here is a short summary of your invoice and next steps.",
    },
    confidence: 0.72,
    metadata: {
      model: MODEL,
      generated_at: GENERATED_AT,
      latency_ms: 42,
    },
  };
}

/** A single planned HTTP response. */
type PlannedResponse = {
  status: number;
  contentType: string;
  body: string;
};

/** JSON-serializes a plain payload with application/json content type. */
function json(status: number, payload: unknown): PlannedResponse {
  return { status, contentType: "application/json", body: JSON.stringify(payload) };
}

/** Plain JSON error body for non-200 responses (content stays provider-side). */
function errorJson(status: number): PlannedResponse {
  return json(status, { error: "internal server error" });
}

/** Builds the response the server must send for a given mode and attempt count. */
function planResponse(mode: ProviderMode, requestCount: number): PlannedResponse {
  switch (mode) {
    case "valid":
      return json(200, validFixture());
    case "unavailable":
      return json(200, {
        ...validFixture(),
        status: "unavailable",
        reply: null,
        confidence: null,
      });
    case "malformed_json":
      return { status: 200, contentType: "text/plain", body: "not json at all" };
    case "wrong_type":
      return json(200, { ...validFixture(), confidence: "high" });
    case "unknown_field":
      return json(200, { ...validFixture(), sentiment: "positive" });
    case "version_2":
      return json(200, { ...validFixture(), contract_version: 2 });
    case "pii_body":
      return json(200, {
        ...validFixture(),
        reply: {
          subject: "Re: your invoice #4821",
          body: `We tried to reach you at ${PII_PHONE} about your invoice.`,
        },
      });
    case "slow":
      return json(200, validFixture());
    case "flaky_500":
      return requestCount === 1 ? errorJson(500) : json(200, validFixture());
    case "always_500":
      return errorJson(500);
  }
}

/** Resolves the request body as a string, or null when the request carries none. */
function readRequestBody(req: http.IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let sawBody = false;
    req.on("data", (chunk: Buffer) => {
      sawBody = true;
      chunks.push(chunk);
    });
    req.on("end", () => resolve(sawBody ? Buffer.concat(chunks).toString("utf8") : null));
    req.on("error", () => resolve(sawBody ? Buffer.concat(chunks).toString("utf8") : null));
  });
}

/**
 * Starts the mock provider bound to 127.0.0.1 on an ephemeral port 0, serving
 * the given mode at `http://127.0.0.1:<port>/v1/suggest`.
 */
export async function startMockProvider(mode: ProviderMode): Promise<MockProvider> {
  let lastRequestBody: string | null = null;
  let requestCount = 0;

  const server = http.createServer(async (req, res) => {
    requestCount++;
    const body = await readRequestBody(req);
    if (body !== null) {
      // Record the raw body verbatim — never parsed; bodyless requests keep the last value.
      lastRequestBody = body;
    }

    const planned = planResponse(mode, requestCount);
    if (mode === "slow") {
      await new Promise((resolve) => setTimeout(resolve, SLOW_DELAY_MS));
    }

    res.writeHead(planned.status, {
      "content-type": planned.contentType,
      "connection": "close",
    });
    res.end(planned.body);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("mock provider failed to bind 127.0.0.1:0");
  }

  const url = `http://127.0.0.1:${address.port}${SUGGESTION_PATH}`;

  return {
    url,
    mode,
    get lastRequestBody(): string | null {
      return lastRequestBody;
    },
    close(): Promise<void> {
      return new Promise((resolve) => {
        server.closeIdleConnections();
        server.close(() => resolve());
      });
    },
  };
}
