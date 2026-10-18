import { describe, expect, it } from "vitest";

import {
  parseContract,
  toDomain,
  type ProviderPayload,
} from "../src/contract.js";

/** Fixed UUID v4-shaped string pinned as the provider fixture identifier. */
const FIXTURE_UUID = "550e8400-e29b-41d4-a716-446655440000";

const validPayload = {
  contract_version: 1,
  suggestion_id: FIXTURE_UUID,
  status: "suggestion",
  reply: {
    subject: "Renew your subscription",
    body: "Hello, your plan renews soon. Want to keep it?",
  },
  confidence: 0.7,
  metadata: {
    model: "mock-model",
    generated_at: "2026-10-19T10:00:00.000Z",
    latency_ms: 120,
  },
};

/** Single source of JSON serialization for payload fixtures. */
function json(payload: unknown): string {
  return JSON.stringify(payload);
}

describe("parseContract — valid payloads", () => {
  it("accepts a full suggestion payload (uuid + reply + confidence 0.7)", () => {
    const outcome = parseContract(json(validPayload));
    expect(outcome).toEqual({
      kind: "valid",
      payload: validPayload,
    });
  });

  it("accepts confidence 0 and confidence 1 (inclusive bounds)", () => {
    for (const confidence of [0, 1]) {
      const outcome = parseContract(json({ ...validPayload, confidence }));
      expect(outcome.kind).toBe("valid");
    }
  });

  it("accepts status=unavailable with reply=null as a valid contract state", () => {
    const outcome = parseContract(
      json({
        contract_version: 1,
        suggestion_id: FIXTURE_UUID,
        status: "unavailable",
        reply: null,
        confidence: null,
        metadata: validPayload.metadata,
      }),
    );
    expect(outcome).toEqual({
      kind: "valid",
      payload: {
        contract_version: 1,
        suggestion_id: FIXTURE_UUID,
        status: "unavailable",
        reply: null,
        confidence: null,
        metadata: validPayload.metadata,
      },
    });
  });
});

describe("parseContract — violations", () => {
  it("reports schema_violation when status=suggestion but reply is null", () => {
    const outcome = parseContract(
      json({ ...validPayload, reply: null }),
    );
    expect(outcome).toEqual({
      kind: "violation",
      reason: "schema_violation",
      detail: expect.any(String),
    });
  });

  it("reports schema_violation when status=unavailable but reply is present", () => {
    const unavailableWithReply = {
      ...validPayload,
      status: "unavailable",
      reply: validPayload.reply,
      confidence: 0.5,
    };
    const outcome = parseContract(json(unavailableWithReply));
    expect(outcome).toEqual({
      kind: "violation",
      reason: "schema_violation",
      detail: expect.any(String),
    });
  });

  it("reports schema_violation for an empty subject", () => {
    const outcome = parseContract(
      json({
        ...validPayload,
        reply: { ...validPayload.reply, subject: "" },
      }),
    );
    expect(outcome).toEqual({
      kind: "violation",
      reason: "schema_violation",
      detail: expect.any(String),
    });
  });

  it("reports schema_violation for confidence above the max (1.5)", () => {
    const outcome = parseContract(json({ ...validPayload, confidence: 1.5 }));
    expect(outcome).toEqual({
      kind: "violation",
      reason: "schema_violation",
      detail: expect.any(String),
    });
  });

  it("reports schema_violation when metadata is absent", () => {
    const { metadata, ...withoutMetadata } = validPayload;
    const outcome = parseContract(json(withoutMetadata));
    expect(outcome).toEqual({
      kind: "violation",
      reason: "schema_violation",
      detail: expect.any(String),
    });
  });

  it("reports schema_violation for an unknown top-level field (strict object)", () => {
    const outcome = parseContract(
      json({ ...validPayload, extra_field: "nope" }),
    );
    expect(outcome).toEqual({
      kind: "violation",
      reason: "schema_violation",
      detail: expect.any(String),
    });
  });

  it("reports version_mismatch before schema validation when contract_version is 2", () => {
    const v2 = { ...validPayload, contract_version: 2, extra_field: "nope" };
    const outcome = parseContract(json(v2));
    expect(outcome).toEqual({
      kind: "violation",
      reason: "version_mismatch",
      detail: expect.any(String),
    });
  });

  it("reports parse_error for an HTML error page body", () => {
    const outcome = parseContract("<html>oops</html>");
    expect(outcome).toEqual({
      kind: "violation",
      reason: "parse_error",
      detail: expect.any(String),
    });
  });

  it("reports parse_error for a non-JSON body", () => {
    const outcome = parseContract("not json");
    expect(outcome).toEqual({
      kind: "violation",
      reason: "parse_error",
      detail: expect.any(String),
    });
  });

  it("never embeds the raw response body in a violation detail", () => {
    for (const raw of [
      "<html>oops</html>",
      "not json",
      json(validPayload).slice(0, 40),
    ]) {
      const outcome = parseContract(raw);
      if (outcome.kind === "violation") {
        expect(outcome.detail).not.toContain("oops");
        expect(outcome.detail).not.toContain("Renew");
        expect(outcome.detail).not.toContain("renews");
      }
    }
  });
});

describe("toDomain", () => {
  it("maps snake_case DTO fields to camelCase domain fields", () => {
    const outcome = parseContract(json(validPayload));
    if (outcome.kind !== "valid") {
      throw new Error("expected a valid outcome");
    }
    const suggestion = toDomain(outcome.payload as ProviderPayload);
    expect(suggestion).toEqual({
      suggestionId: FIXTURE_UUID,
      subject: "Renew your subscription",
      body: "Hello, your plan renews soon. Want to keep it?",
      confidence: 0.7,
    });
  });

  it("returns null only when status=unavailable", () => {
    const outcome = parseContract(
      json({
        contract_version: 1,
        suggestion_id: FIXTURE_UUID,
        status: "unavailable",
        reply: null,
        confidence: null,
        metadata: validPayload.metadata,
      }),
    );
    if (outcome.kind !== "valid") {
      throw new Error("expected a valid outcome");
    }
    expect(toDomain(outcome.payload as ProviderPayload)).toBeNull();
  });
});
