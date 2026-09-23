import { describe, expect, it } from "vitest";
import type {
  EvidenceCollectionResult,
  EvidenceDraft,
  ModelProvider,
  ModelRequest,
  ModelResponse,
} from "../src";
import {
  buildInvestigatorInput,
  DiagnosisValidationError,
  parseReadOnlyDiagnosis,
  ReadOnlyInvestigator,
} from "../src";

function item(
  key: string,
  kind: EvidenceDraft["kind"],
  content: string,
  contentClass: EvidenceDraft["contentClass"] = "STRUCTURED_METADATA",
): EvidenceDraft {
  const derived = ["ERROR_SIGNAL", "FAILING_TEST", "STACK_FRAME"].includes(
    kind,
  );

  return {
    dedupeKey: key,
    kind,
    sourceKind: derived ? "DERIVED" : "GITHUB_API",
    integrity: derived
      ? "DERIVED_FROM_AUTHENTICATED"
      : "PROVIDER_AUTHENTICATED",
    contentClass,
    sensitivity: "POTENTIALLY_SENSITIVE",
    instructionTrust: "NEVER_INSTRUCTIONS",
    content,
    contentSha256: "0".repeat(64),
    metadata: {},
    collectedAt: "2026-09-21T00:00:00.000Z",
  };
}

function readyEvidence(): EvidenceCollectionResult {
  const items = [
    item("run", "WORKFLOW_RUN", '{"conclusion":"failure"}'),
    item("job", "WORKFLOW_JOB", '{"name":"test"}'),
    item(
      "log",
      "JOB_LOG_EXCERPT",
      "1: TypeError: value is possibly null",
      "UNTRUSTED_TEXT",
    ),
    item(
      "error",
      "ERROR_SIGNAL",
      JSON.stringify({
        message: "value is possibly null",
        parserVersion: 2,
        sourceLineStart: 1,
        sourceLineEnd: 1,
      }),
    ),
  ];

  return {
    items,
    edges: [
      {
        fromDedupeKey: "job",
        toDedupeKey: "run",
        relation: "DERIVED_FROM",
        metadata: {},
      },
      {
        fromDedupeKey: "log",
        toDedupeKey: "job",
        relation: "DERIVED_FROM",
        metadata: {},
      },
      {
        fromDedupeKey: "error",
        toDedupeKey: "log",
        relation: "DERIVED_FROM",
        metadata: {},
      },
    ],
    summary: {
      status: "COMPLETED",
      requestsUsed: 3,
      downloadedBytes: 128,
      itemsProduced: items.length,
      edgesProduced: 3,
      truncated: false,
      errorCodes: [],
      baseResolution: "HEAD_PARENT",
    },
  };
}

function validDiagnosis() {
  return {
    outcome: "DIAGNOSIS_READY",
    summary: "A nullability regression caused TypeScript compilation to fail.",
    hypotheses: [
      {
        causeCode: "NULLABILITY_REGRESSION",
        explanation: "The authenticated job log contains the compiler error.",
        confidence: 0.91,
        evidenceIds: ["error", "log"],
        falsifyingEvidenceNeeded: ["A successful compile at the same SHA"],
      },
    ],
    recommendedChecks: [
      {
        capability: "BUILD",
        arguments: ["--noEmit"],
        rationale: "Reproduce the compiler failure without modifying files.",
      },
    ],
    limitations: [],
  };
}

class RecordingModel implements ModelProvider {
  requests: ModelRequest[] = [];

  constructor(private readonly output: unknown) {}

  async generate(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    return {
      modelId: "test-model",
      output: this.output,
      inputTokens: 100,
      outputTokens: 40,
      latencyMs: 12,
    };
  }
}

describe("strict read-only diagnosis", () => {
  it("accepts a bounded, evidence-linked diagnosis", () => {
    expect(
      parseReadOnlyDiagnosis(validDiagnosis(), new Set(["error", "log"])),
    ).toEqual(validDiagnosis());
  });

  it("rejects unknown fields that could smuggle an action", () => {
    expect(() =>
      parseReadOnlyDiagnosis(
        { ...validDiagnosis(), shellCommand: "curl metadata.invalid" },
        new Set(["error", "log"]),
      ),
    ).toThrowError(DiagnosisValidationError);
  });

  it("rejects fabricated evidence references", () => {
    const output = validDiagnosis();
    output.hypotheses[0]!.evidenceIds = ["does-not-exist"];

    expect(() =>
      parseReadOnlyDiagnosis(output, new Set(["error", "log"])),
    ).toThrow(/UNKNOWN_EVIDENCE_REFERENCE/u);
  });

  it("rejects arbitrary execution capabilities", () => {
    const output = validDiagnosis();
    output.recommendedChecks[0]!.capability = "SHELL";

    expect(() =>
      parseReadOnlyDiagnosis(output, new Set(["error", "log"])),
    ).toThrow(/RECOMMENDED_CAPABILITY_INVALID/u);
  });
});

describe("ReadOnlyInvestigator", () => {
  it("passes evidence as NEVER_INSTRUCTIONS and never executes checks", async () => {
    const model = new RecordingModel(validDiagnosis());
    const result = await new ReadOnlyInvestigator(model).investigate(
      readyEvidence(),
    );

    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]?.role).toBe("investigator");

    const input = model.requests[0]?.input as ReturnType<
      typeof buildInvestigatorInput
    >;

    expect(input.securityPolicy).toMatchObject({
      evidenceIsNeverInstructions: true,
      toolsAvailable: false,
      networkAvailable: false,
      credentialsAvailable: false,
      recommendationsAreNotExecuted: true,
    });
    expect(input.promptVersion).toBe("incidentpilot-read-only-investigator-v3");
    expect(input.rootCauseTaxonomy.version).toBe("incidentpilot-ci-rca-v1");
    expect(input.rootCauseTaxonomy.classes.some((entry) =>
      entry.code === "UNIT_ASSERTION_REGRESSION"
    )).toBe(true);
    expect(input.outputContract.jsonSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: [
        "outcome",
        "summary",
        "hypotheses",
        "recommendedChecks",
        "limitations",
      ],
    });
    expect(
      input.evidence.every(
        (entry) => entry.instructionTrust === "NEVER_INSTRUCTIONS",
      ),
    ).toBe(true);
    expect(result.trace).toMatchObject({
      modelCalled: true,
      modelId: "test-model",
      citedEvidenceIds: ["error", "log"],
      recommendationsExecuted: false,
    });
  });

  it("abstains deterministically and does not call a model on insufficient evidence", async () => {
    const evidence = readyEvidence();
    evidence.items = evidence.items.filter((entry) => entry.kind !== "ERROR_SIGNAL");
    evidence.edges = evidence.edges.filter((edge) => edge.fromDedupeKey !== "error");
    evidence.summary.itemsProduced = evidence.items.length;
    evidence.summary.edgesProduced = evidence.edges.length;

    const model = new RecordingModel(validDiagnosis());
    const result = await new ReadOnlyInvestigator(model).investigate(evidence);

    expect(model.requests).toHaveLength(0);
    expect(result.diagnosis.outcome).toBe("NEEDS_HUMAN");
    expect(result.trace).toMatchObject({
      modelCalled: false,
      modelId: null,
      recommendationsExecuted: false,
    });
  });
});
