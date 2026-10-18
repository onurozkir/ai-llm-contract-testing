import { describe, expect, it } from "vitest";

import {
  startMockProvider,
  validFixture,
  type MockProvider,
  type ProviderMode,
} from "../src/provider.js";

/** Raw request body sent by the tests; the provider must record it verbatim. */
const POST_BODY = '{"prompt":"suggest a reply to this customer email"}';
const PHONE = "0532 123 45 67";

/** POSTs a JSON body to the provider endpoint (the way the suggestion service will). */
function post(provider: MockProvider): Promise<Response> {
  return fetch(provider.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: POST_BODY,
  });
}

/** Starts a provider in `mode` and guarantees teardown even if assertions throw. */
async function withProvider<T>(
  mode: ProviderMode,
  run: (provider: MockProvider) => Promise<T>,
): Promise<T> {
  let provider: MockProvider | null = null;
  try {
    provider = await startMockProvider(mode);
    return await run(provider);
  } finally {
    await provider?.close();
  }
}

describe("startMockProvider — basics", () => {
  it("binds 127.0.0.1 with a fixed endpoint path and records no body before any POST", async () => {
    await withProvider("valid", async (provider) => {
      expect(provider.mode).toBe("valid");
      expect(provider.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1\/suggest$/);
      expect(provider.lastRequestBody).toBeNull();
    });
  });

  it("records the raw last POST request body verbatim", async () => {
    await withProvider("valid", async (provider) => {
      await post(provider);
      expect(provider.lastRequestBody).toBe(POST_BODY);
    });
  });
});

describe("startMockProvider — mode: valid", () => {
  it("serves the canonical fixture as JSON with 200", async () => {
    await withProvider("valid", async (provider) => {
      const res = await post(provider);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.json()).toEqual(validFixture());
    });
  });
});

describe("startMockProvider — mode: unavailable", () => {
  it("serves the same fixture shape with status=unavailable, reply=null, confidence=null", async () => {
    await withProvider("unavailable", async (provider) => {
      const res = await post(provider);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ...validFixture(),
        status: "unavailable",
        reply: null,
        confidence: null,
      });
    });
  });
});

describe("startMockProvider — mode: malformed_json", () => {
  it("serves non-JSON text as text/plain", async () => {
    await withProvider("malformed_json", async (provider) => {
      const res = await post(provider);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/plain");
      expect(await res.text()).toBe("not json at all");
    });
  });
});

describe("startMockProvider — mode: wrong_type", () => {
  it("serves the fixture with confidence as a string", async () => {
    await withProvider("wrong_type", async (provider) => {
      const res = await post(provider);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ...validFixture(),
        confidence: "high",
      });
    });
  });
});

describe("startMockProvider — mode: unknown_field", () => {
  it("serves the fixture plus an extra sentiment field", async () => {
    await withProvider("unknown_field", async (provider) => {
      const res = await post(provider);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ...validFixture(),
        sentiment: "positive",
      });
    });
  });
});

describe("startMockProvider — mode: version_2", () => {
  it("serves the fixture with contract_version 2", async () => {
    await withProvider("version_2", async (provider) => {
      const res = await post(provider);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain('"contract_version":2');
      expect(JSON.parse(body)).toEqual({
        ...validFixture(),
        contract_version: 2,
      });
    });
  });
});

describe("startMockProvider — mode: pii_body", () => {
  it("serves the fixture whose reply body contains a raw phone number", async () => {
    await withProvider("pii_body", async (provider) => {
      const res = await post(provider);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { reply: { body: string } };
      expect(body.reply.body).toContain(PHONE);
    });
  });
});

describe("startMockProvider — mode: slow", () => {
  it("serves the valid fixture only after the pinned 2600 ms delay", async () => {
    await withProvider("slow", async (provider) => {
      const startedAt = Date.now();
      const res = await post(provider);
      const elapsed = Date.now() - startedAt;
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(validFixture());
      expect(elapsed).toBeGreaterThanOrEqual(2600);
    });
  });
});

describe("startMockProvider — mode: flaky_500", () => {
  it("returns 500 for the first request and the valid fixture for the second", async () => {
    await withProvider("flaky_500", async (provider) => {
      const first = await post(provider);
      expect(first.status).toBe(500);

      const second = await post(provider);
      expect(second.status).toBe(200);
      expect(await second.json()).toEqual(validFixture());
    });
  });
});

describe("startMockProvider — mode: always_500", () => {
  it("returns 500 on every request", async () => {
    await withProvider("always_500", async (provider) => {
      for (let i = 0; i < 2; i++) {
        const res = await post(provider);
        expect(res.status).toBe(500);
      }
    });
  });
});

describe("validFixture", () => {
  it("has the pinned deterministic values", () => {
    const fixture = validFixture();
    expect(fixture.suggestion_id).toBe("123e4567-e89b-42d3-a456-426614174000");
    expect(fixture.confidence).toBe(0.72);
    expect((fixture.metadata as Record<string, unknown>).model).toBe(
      "mock-gpt-1",
    );
    expect((fixture.metadata as Record<string, unknown>).generated_at).toBe(
      "2026-10-19T09:30:00.000Z",
    );
  });
});
