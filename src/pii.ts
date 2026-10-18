/**
 * PII detection and masking for prompts sent to, and replies received from,
 * the LLM provider.
 *
 * Nothing in this module logs — it is what makes the "no customer data in
 * logs" rule enforceable. Detection order is fixed: phone, email, national_id.
 */

/** Categories of personally identifiable information recognized here. */
export type PiiCategory = "phone" | "email" | "national_id";

/** Email addresses, pinned by the plan. */
const EMAIL_PATTERN = /\b[\w.+-]+@[\w-]+\.[\w.]+\b/;

/** Turkish 11-digit national IDs, pinned by the plan. */
const NATIONAL_ID_PATTERN = /\b\d{11}\b/;

/** Turkish phone numbers with optional prefix and separators, pinned by the plan. */
const PHONE_PATTERN = /\b(?:\+?90|0)?[\s.-]?\d{3}[\s.-]?\d{3}[\s.-]?\d{2}[\s.-]?\d{2}\b/;

/**
 * Categories found in `text`, in the fixed order phone, email, national_id.
 * Each category appears at most once; positions are not reported.
 */
export function detectPii(text: string): PiiCategory[] {
  const found: PiiCategory[] = [];
  if (PHONE_PATTERN.test(text)) found.push("phone");
  if (EMAIL_PATTERN.test(text)) found.push("email");
  if (NATIONAL_ID_PATTERN.test(text)) found.push("national_id");
  return found;
}

/** Replaces each hit with "[masked-<category>]". */
export function maskPii(text: string): string {
  return text
    .replace(PHONE_PATTERN, "[masked-phone]")
    .replace(EMAIL_PATTERN, "[masked-email]")
    .replace(NATIONAL_ID_PATTERN, "[masked-national_id]");
}
