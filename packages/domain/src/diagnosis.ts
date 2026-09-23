import type { ExecutionCapability } from "./ports";
import { ROOT_CAUSE_CODES } from "./root-cause-taxonomy";

export const DIAGNOSIS_OUTCOMES = [
  "DIAGNOSIS_READY",
  "NEEDS_HUMAN",
] as const;

export type DiagnosisOutcome = (typeof DIAGNOSIS_OUTCOMES)[number];

export interface DiagnosisHypothesis {
  causeCode: string;
  explanation: string;
  confidence: number;
  evidenceIds: string[];
  falsifyingEvidenceNeeded: string[];
}

export interface RecommendedCheck {
  capability: ExecutionCapability;
  arguments: string[];
  rationale: string;
}

/**
 * The investigator may propose bounded verification checks, but this value is
 * data only. ReadOnlyInvestigator never owns or calls an ExecutionBackend.
 */
export interface ReadOnlyDiagnosis {
  outcome: DiagnosisOutcome;
  summary: string;
  hypotheses: DiagnosisHypothesis[];
  recommendedChecks: RecommendedCheck[];
  limitations: string[];
}

/**
 * Machine-readable output contract supplied to models. The runtime parser
 * below remains authoritative and deliberately rejects unknown fields.
 */
export const READ_ONLY_DIAGNOSIS_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "outcome",
    "summary",
    "hypotheses",
    "recommendedChecks",
    "limitations",
  ],
  properties: {
    outcome: {
      type: "string",
      enum: ["DIAGNOSIS_READY", "NEEDS_HUMAN"],
    },
    summary: {
      type: "string",
      minLength: 1,
      maxLength: 2_000,
    },
    hypotheses: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "causeCode",
          "explanation",
          "confidence",
          "evidenceIds",
          "falsifyingEvidenceNeeded",
        ],
        properties: {
          causeCode: {
            type: "string",
            enum: ROOT_CAUSE_CODES,
          },
          explanation: {
            type: "string",
            minLength: 1,
            maxLength: 4_000,
          },
          confidence: {
            type: "number",
            minimum: 0,
            maximum: 1,
          },
          evidenceIds: {
            type: "array",
            maxItems: 12,
            uniqueItems: true,
            description:
              "Every value must exactly match an id from the supplied evidence array.",
            items: { type: "string", minLength: 1, maxLength: 160 },
          },
          falsifyingEvidenceNeeded: {
            type: "array",
            maxItems: 8,
            uniqueItems: true,
            items: { type: "string", minLength: 1, maxLength: 400 },
          },
        },
      },
    },
    recommendedChecks: {
      type: "array",
      maxItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["capability", "arguments", "rationale"],
        properties: {
          capability: {
            type: "string",
            enum: ["TEST", "BUILD", "LINT", "STATIC_ANALYSIS"],
          },
          arguments: {
            type: "array",
            maxItems: 16,
            uniqueItems: true,
            items: { type: "string", minLength: 1, maxLength: 256 },
          },
          rationale: {
            type: "string",
            minLength: 1,
            maxLength: 1_000,
          },
        },
      },
    },
    limitations: {
      type: "array",
      maxItems: 12,
      uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: 400 },
    },
  },
} as const;

export function readOnlyDiagnosisSchemaForEvidenceIds(
  evidenceIds: readonly string[],
): unknown {
  return {
    ...READ_ONLY_DIAGNOSIS_JSON_SCHEMA,
    properties: {
      ...READ_ONLY_DIAGNOSIS_JSON_SCHEMA.properties,
      hypotheses: {
        ...READ_ONLY_DIAGNOSIS_JSON_SCHEMA.properties.hypotheses,
        items: {
          ...READ_ONLY_DIAGNOSIS_JSON_SCHEMA.properties.hypotheses.items,
          properties: {
            ...READ_ONLY_DIAGNOSIS_JSON_SCHEMA.properties.hypotheses.items.properties,
            evidenceIds: {
              ...READ_ONLY_DIAGNOSIS_JSON_SCHEMA.properties.hypotheses.items.properties.evidenceIds,
              items: { type: "string", enum: [...new Set(evidenceIds)].sort() },
            },
          },
        },
      },
    },
  };
}

export interface InvestigationTrace {
  promptVersion: string;
  modelCalled: boolean;
  modelId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
  citedEvidenceIds: string[];
  recommendationsExecuted: false;
}

export interface InvestigationResult {
  diagnosis: ReadOnlyDiagnosis;
  trace: InvestigationTrace;
}

export class DiagnosisValidationError extends Error {
  constructor(readonly codes: string[]) {
    super(`Invalid read-only diagnosis: ${codes.join(", ")}`);
    this.name = "DiagnosisValidationError";
  }
}

const CAPABILITIES = new Set<ExecutionCapability>([
  "TEST",
  "BUILD",
  "LINT",
  "STATIC_ANALYSIS",
]);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();

  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

function boundedString(
  value: unknown,
  minimum: number,
  maximum: number,
): value is string {
  return (
    typeof value === "string" &&
    value.trim().length >= minimum &&
    value.length <= maximum &&
    !value.includes("\u0000")
  );
}

function stringArray(
  value: unknown,
  maximumItems: number,
  maximumLength: number,
): string[] | null {
  if (!Array.isArray(value) || value.length > maximumItems) return null;

  if (
    !value.every((entry) => boundedString(entry, 1, maximumLength))
  ) {
    return null;
  }

  const entries = value as string[];
  return new Set(entries).size === entries.length ? entries : null;
}

function parseOutputEnvelope(output: unknown): Record<string, unknown> | null {
  if (typeof output !== "string") return record(output);
  if (output.length > 64 * 1024) return null;

  try {
    return record(JSON.parse(output));
  } catch {
    return null;
  }
}

/**
 * Strictly validates model output and binds every evidence citation to the
 * supplied evidence graph. Unknown fields are rejected instead of ignored so
 * a model cannot smuggle executable or network instructions beside the
 * expected response.
 */
export function parseReadOnlyDiagnosis(
  output: unknown,
  evidenceIds: ReadonlySet<string>,
): ReadOnlyDiagnosis {
  const errors: string[] = [];
  const value = parseOutputEnvelope(output);

  if (!value) {
    throw new DiagnosisValidationError(["OUTPUT_NOT_JSON_OBJECT"]);
  }

  if (
    !exactKeys(value, [
      "outcome",
      "summary",
      "hypotheses",
      "recommendedChecks",
      "limitations",
    ])
  ) {
    errors.push("OUTPUT_FIELDS_INVALID");
  }

  const outcome = value.outcome;
  if (
    typeof outcome !== "string" ||
    !(DIAGNOSIS_OUTCOMES as readonly string[]).includes(outcome)
  ) {
    errors.push("OUTCOME_INVALID");
  }

  if (!boundedString(value.summary, 1, 2_000)) {
    errors.push("SUMMARY_INVALID");
  }

  const limitations = stringArray(value.limitations, 12, 400);
  if (!limitations) errors.push("LIMITATIONS_INVALID");

  const hypotheses: DiagnosisHypothesis[] = [];
  if (!Array.isArray(value.hypotheses) || value.hypotheses.length > 5) {
    errors.push("HYPOTHESES_INVALID");
  } else {
    for (const candidate of value.hypotheses) {
      const hypothesis = record(candidate);

      if (
        !hypothesis ||
        !exactKeys(hypothesis, [
          "causeCode",
          "explanation",
          "confidence",
          "evidenceIds",
          "falsifyingEvidenceNeeded",
        ])
      ) {
        errors.push("HYPOTHESIS_FIELDS_INVALID");
        continue;
      }

      const causeCode = hypothesis.causeCode;
      const explanation = hypothesis.explanation;
      const confidence = hypothesis.confidence;
      const cited = stringArray(hypothesis.evidenceIds, 12, 160);
      const falsifiers = stringArray(
        hypothesis.falsifyingEvidenceNeeded,
        8,
        400,
      );

      if (
        typeof causeCode !== "string" ||
        !/^[A-Z][A-Z0-9_]{2,63}$/u.test(causeCode)
      ) {
        errors.push("CAUSE_CODE_INVALID");
      }

      if (!boundedString(explanation, 1, 4_000)) {
        errors.push("EXPLANATION_INVALID");
      }

      if (
        typeof confidence !== "number" ||
        !Number.isFinite(confidence) ||
        confidence < 0 ||
        confidence > 1
      ) {
        errors.push("CONFIDENCE_INVALID");
      }

      if (!cited) {
        errors.push("EVIDENCE_IDS_INVALID");
      } else if (cited.some((id) => !evidenceIds.has(id))) {
        errors.push("UNKNOWN_EVIDENCE_REFERENCE");
      }

      if (!falsifiers) {
        errors.push("FALSIFIERS_INVALID");
      }

      if (
        typeof causeCode === "string" &&
        boundedString(explanation, 1, 4_000) &&
        typeof confidence === "number" &&
        Number.isFinite(confidence) &&
        confidence >= 0 &&
        confidence <= 1 &&
        cited &&
        cited.every((id) => evidenceIds.has(id)) &&
        falsifiers
      ) {
        hypotheses.push({
          causeCode,
          explanation,
          confidence,
          evidenceIds: [...cited],
          falsifyingEvidenceNeeded: [...falsifiers],
        });
      }
    }
  }

  const recommendedChecks: RecommendedCheck[] = [];
  if (
    !Array.isArray(value.recommendedChecks) ||
    value.recommendedChecks.length > 4
  ) {
    errors.push("RECOMMENDED_CHECKS_INVALID");
  } else {
    for (const candidate of value.recommendedChecks) {
      const check = record(candidate);

      if (
        !check ||
        !exactKeys(check, ["capability", "arguments", "rationale"])
      ) {
        errors.push("RECOMMENDED_CHECK_FIELDS_INVALID");
        continue;
      }

      const capability = check.capability;
      const args = stringArray(check.arguments, 16, 256);
      const rationale = check.rationale;

      if (
        typeof capability !== "string" ||
        !CAPABILITIES.has(capability as ExecutionCapability)
      ) {
        errors.push("RECOMMENDED_CAPABILITY_INVALID");
      }

      if (!args) errors.push("RECOMMENDED_ARGUMENTS_INVALID");
      if (!boundedString(rationale, 1, 1_000)) {
        errors.push("RECOMMENDED_RATIONALE_INVALID");
      }

      if (
        typeof capability === "string" &&
        CAPABILITIES.has(capability as ExecutionCapability) &&
        args &&
        boundedString(rationale, 1, 1_000)
      ) {
        recommendedChecks.push({
          capability: capability as ExecutionCapability,
          arguments: [...args],
          rationale,
        });
      }
    }
  }

  if (outcome === "DIAGNOSIS_READY" && hypotheses.length === 0) {
    errors.push("DIAGNOSIS_READY_WITHOUT_HYPOTHESIS");
  }

  if (errors.length > 0) {
    throw new DiagnosisValidationError([...new Set(errors)].sort());
  }

  return {
    outcome: outcome as DiagnosisOutcome,
    summary: value.summary as string,
    hypotheses,
    recommendedChecks,
    limitations: [...(limitations ?? [])],
  };
}

export function citedEvidenceIds(
  diagnosis: ReadOnlyDiagnosis,
): string[] {
  return [
    ...new Set(
      diagnosis.hypotheses.flatMap((hypothesis) => hypothesis.evidenceIds),
    ),
  ].sort();
}
