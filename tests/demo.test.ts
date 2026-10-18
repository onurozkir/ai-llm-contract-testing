import { describe, it, expect } from "vitest";
import { runScenario } from "../demo/cli.js";

describe("demo - runScenario()", () => {
  it("runs valid scenario and returns formatted lines matching contract", async () => {
    const lines = await runScenario("valid");
    expect(lines.length).toBe(3);

    // Line 1: ticket line
    expect(lines[0]).toMatch(
      /^\[ticket\] t-refund v1 — deterministic suggestion ready in \d+ms$/
    );

    // Line 2: llm accepted line
    expect(lines[1]).toBe(
      "[llm] suggestion accepted: Re: your invoice #4821"
    );

    // Line 3: metrics line
    expect(lines[2]).toMatch(
      /^\[metrics\] accepted=1 violations=0 timeouts=0 pii=0 p99=\d+ms$/
    );
  });

  it("runs slow scenario: shows timeout and proves deterministic flow ready < 50ms", async () => {
    const lines = await runScenario("slow");
    expect(lines.length).toBe(3);

    const match = lines[0].match(/ready in (\d+)ms/);
    expect(match).not.toBeNull();
    const ms = Number(match![1]);
    expect(ms).toBeLessThan(50);

    expect(lines[1]).toBe(
      "[llm] no suggestion (timeout) — deterministic flow continued"
    );
  });

  it("runs pii_body scenario: shows pii_detected", async () => {
    const lines = await runScenario("pii_body");
    expect(lines.length).toBe(3);
    expect(lines[1]).toBe(
      "[llm] no suggestion (pii_detected) — deterministic flow continued"
    );
  });
});
