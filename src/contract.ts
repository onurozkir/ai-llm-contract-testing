/**
 * Zero-trust validation of the LLM provider's JSON response.
 *
 * `parseContract` never trusts the raw body: it JSON.parses it, gates on the
 * contract version before any other schema logic, and only then runs the
 * strict zod schema. Violations carry counts-friendly reason codes and a
 * short stable detail string — never the raw response body or any customer
 * or model text. This module does no logging.
 */
import { z } from "zod";

import type { Suggestion } from "./domain.js";

/** Wire contract version produced by the provider; any other value is rejected. */
export const CONTRACT_VERSION = 1;

/** Canonical reason codes for a rejected provider response. */
export type ViolationReason = "parse_error" | "schema_violation" | "version_mismatch";

/**
 * Strict DTO shape for the provider response. Internal to this module —
 * only the `ProviderPayload` type is exported.
 */
const providerResponseSchema = z
  .object({
    contract_version: z.literal(1),
    suggestion_id: z.string().uuid(),
    status: z.enum(["suggestion", "unavailable"]),
    reply: z
      .object({
        subject: z.string().min(1).max(200),
        body: z.string().min(1).max(4000),
      })
      .nullable(),
    confidence: z.number().min(0).max(1).nullable(),
    metadata: z.object({
      model: z.string().min(1),
      generated_at: z.string().datetime(),
      latency_ms: z.number().int().nonnegative(),
    }),
  })
  .strict()
  // A suggestion payload carries a reply; "unavailable" carries none.
  .refine((p) => (p.status === "suggestion") === (p.reply !== null));

/** The inferred shape of a valid provider response payload. */
export type ProviderPayload = z.infer<typeof providerResponseSchema>;

/** Result of validating a raw provider response body. */
export type ContractOutcome =
  | { kind: "valid"; payload: ProviderPayload }
  | { kind: "violation"; reason: ViolationReason; detail: string };

/**
 * Validates `rawText` as a provider response: JSON.parse → version gate →
 * strict schema. The detail string is short and stable (first issue message
 * or "unexpected JSON") and never contains the raw body.
 */
export function parseContract(rawText: string): ContractOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { kind: "violation", reason: "parse_error", detail: "unexpected JSON" };
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as Record<string, unknown>).contract_version !== CONTRACT_VERSION
  ) {
    return {
      kind: "violation",
      reason: "version_mismatch",
      detail: `contract_version must be ${CONTRACT_VERSION}`,
    };
  }

  const result = providerResponseSchema.safeParse(parsed);
  if (!result.success) {
    return {
      kind: "violation",
      reason: "schema_violation",
      detail: result.error.issues[0]?.message ?? "schema violation",
    };
  }

  return { kind: "valid", payload: result.data };
}

/**
 * Maps a valid payload onto the domain. Returns `null` only for the
 * legitimate `status: "unavailable"` contract state — never as an error.
 */
export function toDomain(payload: ProviderPayload): Suggestion | null {
  if (payload.status === "unavailable") {
    return null;
  }
  return {
    suggestionId: payload.suggestion_id,
    subject: payload.reply?.subject ?? "",
    body: payload.reply?.body ?? "",
    confidence: payload.confidence,
  };
}
