import type { AgenticInvestigationResult } from "@incidentpilot/domain";

function escapeCell(value: string): string {
  return value.replace(/\|/gu, "\\|").replace(/\r?\n/gu, " ");
}

export function agentMarkdownReport(
  title: string,
  result: AgenticInvestigationResult,
  createdAt: string,
): string {
  const top = [...result.diagnosis.hypotheses]
    .sort((left, right) => right.confidence - left.confidence)[0];
  const lines = [
    `# IncidentPilot evidence-agent demonstration`,
    "",
    `- Scenario: ${title}`,
    `- Created: ${createdAt}`,
    `- Outcome: ${result.diagnosis.outcome}`,
    `- Root-cause class: ${top?.causeCode ?? "n/a"}`,
    `- Confidence: ${top ? top.confidence.toFixed(2) : "n/a"}`,
    `- Model calls: ${result.trace.modelCalls}/${result.trace.budgets.maximumModelCalls}`,
    `- Read-only tool calls: ${result.trace.toolCalls}/${result.trace.budgets.maximumToolCalls}`,
    `- Rejected tool calls: ${result.trace.rejectedToolCalls}`,
    `- Recommendations executed: no`,
    "",
    "## Diagnosis",
    "",
    result.diagnosis.summary,
    "",
    "## Verified hypotheses",
    "",
    "| Class | Status | Confidence | Evidence |",
    "| --- | --- | ---: | --- |",
    ...(result.verification.at(-1)?.hypotheses ?? []).map((entry) =>
      `| ${escapeCell(entry.failureClass)} | ${entry.status} | ${entry.confidence.toFixed(2)} | ${escapeCell(entry.evidenceIds.join(", "))} |`
    ),
    "",
    "## Evidence acquired by the bounded broker",
    "",
    "| Observation | Tool | Provenance | Truncated |",
    "| --- | --- | --- | --- |",
    ...result.observations.map((entry) =>
      `| ${entry.id} | ${entry.request.tool} | ${escapeCell(entry.sourceEvidenceIds.join(", "))} | ${entry.truncated ? "yes" : "no"} |`
    ),
    "",
    "## Auditable trajectory",
    "",
    "| # | Phase | Event | Detail |",
    "| ---: | --- | --- | --- |",
    ...result.trace.events.map((entry) =>
      `| ${entry.sequence} | ${entry.phase} | ${entry.kind} | ${escapeCell(entry.detail)} |`
    ),
    "",
    "## Safety properties demonstrated",
    "",
    "- The runtime, not the model, controls phase transitions and the conclusion gate.",
    "- Tools are typed, read-only, budgeted, duplicate-suppressed, and provenance checked.",
    "- Tool output and repository evidence remain `NEVER_INSTRUCTIONS`.",
    "- Root-cause classes come from a public, versioned taxonomy.",
    "- A diagnosis must cite evidence and match a hypothesis marked `SUPPORTED` during verification.",
    "- Recommended checks remain data and are not executed.",
    "",
  ];
  return `${lines.join("\n")}\n`;
}
