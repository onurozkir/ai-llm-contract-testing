/**
 * Deterministic ticket flow and fallback suggestions.
 * Provides seeded customer tickets containing realistic PII and rule-based
 * fallback suggestions that never echo customer PII.
 */
import type { Suggestion } from "./domain.js";

export type Ticket = {
  id: string;
  version: number;
  subject: string;
  body: string; // deliberately PII-ish customer text
  category: "refund" | "shipping" | "general";
};

export class TicketStore {
  private tickets = new Map<string, Ticket>();

  /**
   * Seeds two example customer tickets with PII-ish data for testing.
   */
  seed(): void {
    this.tickets.set("t-refund", {
      id: "t-refund",
      version: 1,
      category: "refund",
      subject: "Refund request for order #8817",
      body: "Order 8817 hasn't arrived, please refund or call 0532 123 45 67 or email customer@example.com.",
    });

    this.tickets.set("t-general", {
      id: "t-general",
      version: 1,
      category: "general",
      subject: "Inquiry about support hours and account setup",
      body: "Hello, what are your support hours? Please reach out to client@company.com or call 0542 987 65 43.",
    });
  }

  get(id: string): Ticket {
    const ticket = this.tickets.get(id);
    if (!ticket) {
      throw new Error(`Ticket not found: ${id}`);
    }
    return { ...ticket };
  }

  bumpVersion(id: string): number {
    const ticket = this.get(id);
    ticket.version += 1;
    this.tickets.set(id, ticket);
    return ticket.version;
  }
}

/**
 * Returns a canned deterministic suggestion based solely on the ticket category.
 * Confidence is always null, and body never echoes customer PII.
 */
export function deterministicSuggestion(ticket: Ticket): Suggestion {
  const suggestionId = `${ticket.id}-d${ticket.version}`;
  let subject = "";
  let body = "";

  switch (ticket.category) {
    case "refund":
      subject = "Re: Your refund inquiry";
      body =
        "Hello, we have received your refund request and are reviewing it according to our return policy. We will get back to you shortly.";
      break;
    case "shipping":
      subject = "Re: Your shipping inquiry";
      body =
        "Hello, we are tracking your shipment with our courier partner. You will receive tracking updates within one business day.";
      break;
    case "general":
    default:
      subject = "Re: Your inquiry";
      body =
        "Hello, thank you for reaching out. A support specialist will review your request and reply shortly.";
      break;
  }

  return {
    suggestionId,
    subject,
    body,
    confidence: null,
  };
}

