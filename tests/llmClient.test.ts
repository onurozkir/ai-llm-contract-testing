import { describe, it, expect } from "vitest";
import { postSuggestionRequest } from "../src/llmClient.js";
import { startMockProvider } from "../src/provider.js";

describe("postSuggestionRequest", () => {
  it("returns ok:true with text and elapsedMs on valid provider", async () => {
    const provider = await startMockProvider("valid");
    try {
      const result = await postSuggestionRequest(
        provider.url,
        JSON.stringify({ query: "hello" }),
        1000
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(JSON.parse(result.text)).toHaveProperty("contract_version", 1);
        expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
      }
    } finally {
      await provider.close();
    }
  });

  it("aborts when server is slow and returns reason:timeout within deadline", async () => {
    const provider = await startMockProvider("slow");
    try {
      const start = Date.now();
      const result = await postSuggestionRequest(
        provider.url,
        JSON.stringify({ query: "hello" }),
        200
      );
      const elapsed = Date.now() - start;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("timeout");
      }
      expect(elapsed).toBeLessThan(1000);
    } finally {
      await provider.close();
    }
  });

  it("returns reason:http_5xx and status on 500 server response", async () => {
    const provider = await startMockProvider("always_500");
    try {
      const result = await postSuggestionRequest(
        provider.url,
        JSON.stringify({ query: "hello" }),
        1000
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("http_5xx");
        expect(result.status).toBe(500);
      }
    } finally {
      await provider.close();
    }
  });

  it("returns reason:network when connecting to an unreachable port", async () => {
    const provider = await startMockProvider("valid");
    const closedUrl = provider.url;
    await provider.close();

    const result = await postSuggestionRequest(
      closedUrl,
      JSON.stringify({ query: "hello" }),
      1000
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("network");
    }
  });
});
