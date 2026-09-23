import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli";

describe("evaluation CLI model-call gate", () => {
  it("fails closed for a live provider without explicit authorization", () => {
    expect(() => parseArgs([
      "--provider",
      "openai-compatible",
    ])).toThrow(/--model-calls-enabled/u);
  });

  it("accepts a live provider only with the explicit model-call flag", () => {
    expect(parseArgs([
      "--provider",
      "openai-compatible",
      "--model-calls-enabled",
      "--no-write",
    ])).toMatchObject({
      provider: "openai-compatible",
      modelCallsEnabled: true,
      write: false,
      timeoutMs: 120_000,
    });
  });

  it("accepts a bounded timeout override for slower local models", () => {
    expect(parseArgs([
      "--provider",
      "openai-compatible",
      "--model-calls-enabled",
      "--timeout-ms",
      "90000",
    ]).timeoutMs).toBe(90_000);

    expect(() => parseArgs([
      "--provider",
      "openai-compatible",
      "--model-calls-enabled",
      "--timeout-ms",
      "120001",
    ])).toThrow(/1 to 120000/u);
  });

  it("keeps the scripted self-test model-free", () => {
    expect(parseArgs([
      "--provider",
      "scripted",
      "--gate-security",
    ])).toMatchObject({
      provider: "scripted",
      modelCallsEnabled: false,
      gateSecurity: true,
    });
  });
});
