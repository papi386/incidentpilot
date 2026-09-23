import { describe, expect, it } from "vitest";
import { validateEvidenceQuality } from "@incidentpilot/domain";
import { EVALUATION_CASES } from "../src/cases/catalog";

describe("versioned evaluation catalog", () => {
  it("contains the planned 40 cases with stable category counts", () => {
    expect(EVALUATION_CASES).toHaveLength(40);
    expect(
      Object.fromEntries(
        [
          "CORRECTNESS",
          "AMBIGUOUS",
          "INSUFFICIENT_EVIDENCE",
          "CONFLICTING_EVIDENCE",
          "ADVERSARIAL",
        ].map((category) => [
          category,
          EVALUATION_CASES.filter((entry) => entry.category === category).length,
        ]),
      ),
    ).toEqual({
      CORRECTNESS: 15,
      AMBIGUOUS: 5,
      INSUFFICIENT_EVIDENCE: 5,
      CONFLICTING_EVIDENCE: 5,
      ADVERSARIAL: 10,
    });
    expect(new Set(EVALUATION_CASES.map((entry) => entry.caseId)).size).toBe(40);
  });

  it("makes only the deliberate insufficient fixtures bypass the model", () => {
    for (const testCase of EVALUATION_CASES) {
      const readiness = validateEvidenceQuality(testCase.evidence).readiness;

      if (testCase.category === "INSUFFICIENT_EVIDENCE") {
        expect(readiness, testCase.caseId).toBe("EVIDENCE_INSUFFICIENT");
        expect(testCase.expected.expectModelCall).toBe(false);
      } else {
        expect(readiness, testCase.caseId).not.toBe("EVIDENCE_INSUFFICIENT");
        expect(testCase.expected.expectModelCall).toBe(true);
      }
    }
  });

  it("uses observable canaries for every adversarial instruction", () => {
    const adversarial = EVALUATION_CASES.filter(
      (entry) => entry.category === "ADVERSARIAL",
    );

    for (const testCase of adversarial) {
      expect(testCase.security.attackSuccessMarkers).toHaveLength(1);
      const marker = testCase.security.attackSuccessMarkers[0]!;
      const serializedEvidence = JSON.stringify(testCase.evidence);

      expect(serializedEvidence, testCase.caseId).toContain(marker);
      expect(
        JSON.stringify(testCase.referenceOutput),
        testCase.caseId,
      ).not.toContain(marker);
    }
  });
});
