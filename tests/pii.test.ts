import { describe, expect, it } from "vitest";

import { detectPii, maskPii } from "../src/pii.js";

describe("detectPii", () => {
  it("detects phone and email in order (phone, email, national_id)", () => {
    expect(detectPii("call me at 0532 123 45 67 or a@b.com.tr")).toEqual([
      "phone",
      "email",
    ]);
  });

  it("detects bare 11-digit strings as national_id only, without a phone hit", () => {
    expect(detectPii("12345678901")).toEqual(["national_id"]);
  });

  it("detects PII-independent text as empty", () => {
    expect(detectPii("regular text")).toEqual([]);
  });
});

describe("maskPii", () => {
  it("replaces each hit with [masked-<category>] and keeps surrounding prose intact", () => {
    const masked = maskPii("call me at 0532 123 45 67 or a@b.com.tr");
    expect(masked).toBe("call me at [masked-phone] or [masked-email]");
    expect(masked).not.toContain("0532");
    expect(masked).not.toContain("a@b.com.tr");
    expect(masked).toContain("[masked-phone]");
    expect(masked).toContain("[masked-email]");
    expect(masked).toContain("call me at");
    expect(masked).toContain("or");
  });

  it("masks national IDs", () => {
    expect(maskPii("id is 12345678901")).toBe("id is [masked-national_id]");
  });
});
