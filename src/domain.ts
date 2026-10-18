/**
 * Domain model for a reply suggestion, decoupled from the wire contract.
 *
 * This file imports nothing — pure types only, per the architecture rule:
 * only `src/contract.ts` maps provider DTO shapes onto the domain.
 */

/** A reply suggestion as the rest of the system consumes it. */
export type Suggestion = {
  suggestionId: string;
  subject: string;
  body: string;
  confidence: number | null;
};
