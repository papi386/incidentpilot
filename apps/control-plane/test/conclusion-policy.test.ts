import { describe, expect, it } from "vitest";
import { isDiagnosticFailureConclusion, isIncidentConclusion } from "../src/github/conclusion-policy";

describe("GitHub conclusion policy", () => {
  it("does not let cancelled/success-like jobs consume diagnostic failure capacity", () => {
    for (const value of ["success", "neutral", "skipped", "cancelled"]) {
      expect(isDiagnosticFailureConclusion(value)).toBe(false);
      expect(isIncidentConclusion(value)).toBe(false);
    }
    for (const value of ["failure", "timed_out", "stale", "action_required"]) {
      expect(isDiagnosticFailureConclusion(value)).toBe(true);
      expect(isIncidentConclusion(value)).toBe(true);
    }
  });
});
