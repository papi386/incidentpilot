import { describe, expect, it } from "vitest";
import { GitHubApiError } from "../src/github/github-api";
import { evidenceRetryDelayMs } from "../src/security/retry-policy";

describe("evidence retry policy", () => {
  it("honors provider retry guidance", () => {
    expect(evidenceRetryDelayMs(1, new GitHubApiError("RATE_LIMITED", 429, undefined, 42_000))).toBe(42_000);
  });
  it("uses bounded exponential fallback", () => {
    const delay = evidenceRetryDelayMs(2, new Error("network"));
    expect(delay).toBeGreaterThanOrEqual(10_000);
    expect(delay).toBeLessThan(12_000);
  });
});
