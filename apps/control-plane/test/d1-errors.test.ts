import { describe, expect, it } from "vitest";
import {
  classifyD1ResourceExhaustion,
  parseWorkflowResourceExhaustion,
  secondsUntilNextUtcMidnight,
  workflowResourceExhaustionMessage
} from "../src/security/d1-errors";

describe("D1 resource exhaustion classification", () => {
  const now = new Date("2026-09-11T20:00:00.000Z");

  it("classifies the free-tier row-read limit and waits for UTC reset", () => {
    const result = classifyD1ResourceExhaustion(
      new Error("Your account has exceeded D1's free tier daily row read limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue."),
      now
    );

    expect(result).toEqual({ kind: "ROW_READ_LIMIT", retryAfterSeconds: 14_400 });
  });

  it("classifies the free-tier row-write limit", () => {
    const result = classifyD1ResourceExhaustion(
      new Error("Your account has exceeded D1's free tier daily row write limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue."),
      now
    );

    expect(result?.kind).toBe("ROW_WRITE_LIMIT");
  });


  it("classifies database/account storage exhaustion without treating it as midnight-resetting quota", () => {
    expect(classifyD1ResourceExhaustion(
      new Error("D1_ERROR: Exceeded maximum DB size."),
      now
    )).toEqual({ kind: "DATABASE_SIZE_LIMIT", retryAfterSeconds: 3600 });

    expect(classifyD1ResourceExhaustion(
      new Error("Your account has exceeded D1's maximum account storage limit, please contact Cloudflare to raise your limit"),
      now
    )).toEqual({ kind: "ACCOUNT_STORAGE_LIMIT", retryAfterSeconds: 3600 });
  });

  it("does not misclassify ordinary transient database errors", () => {
    expect(classifyD1ResourceExhaustion(new Error("D1_ERROR: database temporarily unavailable"), now)).toBeNull();
  });

  it("round-trips the non-retryable workflow marker", () => {
    const exhaustion = { kind: "ROW_READ_LIMIT" as const, retryAfterSeconds: 1234 };
    expect(parseWorkflowResourceExhaustion(new Error(workflowResourceExhaustionMessage(exhaustion)))).toEqual(exhaustion);
  });

  it("computes a positive reset interval", () => {
    expect(secondsUntilNextUtcMidnight(new Date("2026-09-11T23:59:59.500Z"))).toBe(1);
  });
});
