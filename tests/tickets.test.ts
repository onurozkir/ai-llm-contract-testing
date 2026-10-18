import { describe, it, expect, beforeEach } from "vitest";
import { TicketStore, deterministicSuggestion } from "../src/tickets.js";

describe("TicketStore and deterministicSuggestion", () => {
  let store: TicketStore;

  beforeEach(() => {
    store = new TicketStore();
    store.seed();
  });

  it("seeds and retrieves tickets with customer text containing PII", () => {
    const refundTicket = store.get("t-refund");
    expect(refundTicket).toBeDefined();
    expect(refundTicket.category).toBe("refund");
    expect(refundTicket.body).toContain("0532 123 45 67");
    expect(refundTicket.body).toContain("customer@example.com");

    const generalTicket = store.get("t-general");
    expect(generalTicket).toBeDefined();
    expect(generalTicket.category).toBe("general");
  });

  it("throws when retrieving a non-existent ticket", () => {
    expect(() => store.get("non-existent")).toThrow(/not found/i);
  });

  it("increments version and updates suggestionId upon bumpVersion", () => {
    const initialTicket = store.get("t-refund");
    expect(initialTicket.version).toBe(1);

    const suggestion1 = deterministicSuggestion(initialTicket);
    expect(suggestion1.suggestionId).toBe("t-refund-d1");

    const newVersion = store.bumpVersion("t-refund");
    expect(newVersion).toBe(2);

    const updatedTicket = store.get("t-refund");
    expect(updatedTicket.version).toBe(2);

    const suggestion2 = deterministicSuggestion(updatedTicket);
    expect(suggestion2.suggestionId).toBe("t-refund-d2");
  });

  it("produces category-specific suggestions with confidence:null and never leaks customer PII", () => {
    const refundTicket = store.get("t-refund");
    const generalTicket = store.get("t-general");

    const refundSuggestion = deterministicSuggestion(refundTicket);
    const generalSuggestion = deterministicSuggestion(generalTicket);

    expect(refundSuggestion.confidence).toBeNull();
    expect(generalSuggestion.confidence).toBeNull();
    expect(refundSuggestion.subject).not.toBe(generalSuggestion.subject);
    expect(refundSuggestion.body).not.toBe(generalSuggestion.body);

    // Assert that fallback never echoes customer PII
    expect(refundSuggestion.body).not.toContain("0532 123 45 67");
    expect(refundSuggestion.body).not.toContain("customer@example.com");
    expect(generalSuggestion.body).not.toContain("0532 123 45 67");
    expect(generalSuggestion.body).not.toContain("customer@example.com");
  });
});
