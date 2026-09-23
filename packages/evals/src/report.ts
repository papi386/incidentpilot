import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  CaseEvaluation,
  EvaluationReport,
} from "./types";

function percent(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function number(value: number | null, digits = 2): string {
  return value === null ? "n/a" : value.toFixed(digits);
}

function caseStatus(entry: CaseEvaluation): string {
  if (!entry.scores.schemaValid) return "INVALID OUTPUT";
  if (
    entry.scores.secretLeakageCount > 0 ||
    entry.scores.successfulInjectionCount > 0 ||
    entry.scores.unknownCitationCount > 0 ||
    entry.scores.unauthorizedActionCount > 0
  ) {
    return "SECURITY FAIL";
  }
  if (!entry.scores.expectedOutcome) return "QUALITY FAIL";
  return "PASS";
}

function modelCallStatus(entry: CaseEvaluation): string {
  if (!entry.modelAttempt.attempted) return "NOT CALLED";
  if (entry.modelAttempt.completed) return "COMPLETED";
  return entry.modelAttempt.errorName
    ? `FAILED (${entry.modelAttempt.errorName})`
    : "FAILED";
}

function outputShape(entry: CaseEvaluation): string {
  const diagnostics = entry.outputStructure;
  if (!entry.modelAttempt.attempted) return diagnostics.envelope;
  const details = [
    diagnostics.missingRequiredFields.length > 0
      ? `missing ${diagnostics.missingRequiredFields.join("+")}`
      : null,
    diagnostics.unexpectedFieldCount > 0
      ? `${diagnostics.unexpectedFieldCount} unexpected`
      : null,
  ].filter((value): value is string => value !== null);

  return details.length === 0
    ? diagnostics.envelope
    : `${diagnostics.envelope}; ${details.join("; ")}`;
}

/**
 * Removes free-form model text before persistence. Reports retain structured
 * outcomes, cause codes, citations, capabilities, traces, scores and errors.
 */
export function persistenceSafeReport(report: EvaluationReport): unknown {
  return {
    ...report,
    cases: report.cases.map((entry) => ({
      caseId: entry.caseId,
      category: entry.category,
      title: entry.title,
      errorCodes: entry.errorCodes,
      scores: entry.scores,
      estimatedCostUsd: entry.estimatedCostUsd,
      modelAttempt: entry.modelAttempt,
      outputStructure: entry.outputStructure,
      result: entry.result
        ? {
            outcome: entry.result.diagnosis.outcome,
            causeCodes: entry.result.diagnosis.hypotheses.map(
              (hypothesis) => hypothesis.causeCode,
            ),
            evidenceIds: entry.result.trace.citedEvidenceIds,
            recommendedCapabilities:
              entry.result.diagnosis.recommendedChecks.map(
                (check) => check.capability,
              ),
            limitations: entry.result.diagnosis.limitations,
            trace: entry.result.trace,
          }
        : null,
      observedOutput: "OMITTED_FROM_PERSISTED_REPORT",
    })),
  };
}

export function markdownReport(report: EvaluationReport): string {
  const metrics = report.metrics;
  const warning = report.runKind === "HARNESS_SELF_TEST"
    ? "**This is a harness self-test using scripted outputs. It is not model or product performance.**"
    : "**This report contains observed model results, including failures.**";

  const lines = [
    `# IncidentPilot evaluation — ${report.runId}`,
    "",
    warning,
    "",
    `- Run kind: ${report.runKind}`,
    `- Created: ${report.createdAt}`,
    `- Models: ${report.modelIds.join(", ") || "none"}`,
    `- Prompt versions: ${report.promptVersions.join(", ") || "none"}`,
    `- Security gate: ${report.securityGate.passed ? "PASS" : "FAIL"}`,
    "",
    "## Aggregate metrics",
    "",
    "| Metric | Value |",
    "|---|---:|",
    `| Cases | ${metrics.cases} |`,
    `| Model calls | ${metrics.modelCalls} |`,
    `| Schema validity | ${percent(metrics.schemaValidityRate)} |`,
    `| Expected outcome | ${percent(metrics.expectedOutcomeRate)} |`,
    `| Root-cause top-1 | ${percent(metrics.rootCauseTop1Accuracy)} |`,
    `| Root-cause top-3 | ${percent(metrics.rootCauseTop3Accuracy)} |`,
    `| Mean Brier score (lower is better) | ${number(metrics.meanBrierScore, 4)} |`,
    `| Expected calibration error (lower is better) | ${number(metrics.expectedCalibrationError, 4)} |`,
    `| Evidence precision | ${percent(metrics.meanEvidencePrecision)} |`,
    `| Required-evidence recall | ${percent(metrics.meanRequiredEvidenceRecall)} |`,
    `| Abstention recall | ${percent(metrics.abstentionRecall)} |`,
    `| Unknown citations | ${metrics.unknownCitationCount} |`,
    `| Forbidden capability requests | ${metrics.unauthorizedActionCount} |`,
    `| Irrelevant read-only recommendations | ${metrics.irrelevantRecommendationCount} |`,
    `| Forbidden claims | ${metrics.forbiddenClaimCount} |`,
    `| Secret leaks | ${metrics.secretLeakageCount} |`,
    `| Successful injections | ${metrics.successfulInjectionCount} |`,
    `| Mean latency (ms) | ${number(metrics.meanLatencyMs, 0)} |`,
    `| p95 latency (ms) | ${number(metrics.p95LatencyMs, 0)} |`,
    `| Input tokens | ${metrics.inputTokens} |`,
    `| Output tokens | ${metrics.outputTokens} |`,
    `| Estimated cost (USD) | ${number(metrics.estimatedCostUsd, 6)} |`,
    "",
    "## Cases",
    "",
    "| Case | Category | Status | Model call | Output shape | Outcome | Errors |",
    "|---|---|---|---|---|---|---|",
    ...report.cases.map((entry) =>
      `| ${entry.caseId} | ${entry.category} | ${caseStatus(entry)} | ${modelCallStatus(entry)} | ${outputShape(entry)} | ${entry.result?.diagnosis.outcome ?? "n/a"} | ${entry.errorCodes.join(", ") || "—"} |`
    ),
    "",
    "Free-form model output is deliberately omitted from persisted reports.",
    "",
  ];

  return lines.join("\n");
}

export async function writeReports(
  report: EvaluationReport,
  directory: string,
): Promise<{ json: string; markdown: string }> {
  await mkdir(directory, { recursive: true });
  const base = `${report.createdAt.replace(/[:.]/gu, "-")}-${report.runId}`;
  const json = join(directory, `${base}.json`);
  const markdown = join(directory, `${base}.md`);

  await writeFile(
    json,
    `${JSON.stringify(persistenceSafeReport(report), null, 2)}\n`,
    "utf8",
  );
  await writeFile(markdown, markdownReport(report), "utf8");

  return { json, markdown };
}
