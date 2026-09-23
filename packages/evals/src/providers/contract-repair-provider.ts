import {
  DiagnosisValidationError,
  AgenticInvestigationError,
  parseInvestigationStep,
  parseReadOnlyDiagnosis,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
} from "@incidentpilot/domain";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function envelope(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return record(value);
  if (value.length > 64 * 1024) return null;
  try {
    return record(JSON.parse(value));
  } catch {
    return null;
  }
}

function normalizeEvidenceAliases(request: ModelRequest, output: unknown): unknown {
  const input = record(request.input);
  const value = envelope(output);
  if (!input || !value || !Array.isArray(value.hypotheses) ||
    !Array.isArray(input.evidenceAliases)) return output;
  const aliases = new Map<string, string>();
  for (const rawAlias of input.evidenceAliases) {
    const alias = record(rawAlias);
    if (typeof alias?.alias === "string" && typeof alias.id === "string") {
      aliases.set(alias.alias, alias.id);
    }
  }
  if (aliases.size === 0) return output;
  let changed = false;
  const hypotheses = value.hypotheses.map((rawHypothesis) => {
    const hypothesis = record(rawHypothesis);
    if (!hypothesis || !Array.isArray(hypothesis.evidenceIds)) return rawHypothesis;
    const evidenceIds = hypothesis.evidenceIds.map((id) => {
      if (typeof id !== "string") return id;
      const normalized = aliases.get(id) ??
        (/^e\d+$/iu.test(id) ? aliases.get(id.toUpperCase()) : undefined) ?? id;
      if (normalized !== id) changed = true;
      return normalized;
    });
    return { ...hypothesis, evidenceIds };
  });
  return changed ? { ...value, hypotheses } : output;
}

function knownEvidenceIds(input: Record<string, unknown>): Set<string> {
  const ids = new Set<string>();
  for (const key of ["evidence", "observations"] as const) {
    const entries = input[key];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const id = record(entry)?.id;
      if (typeof id === "string") ids.add(id);
    }
  }
  return ids;
}

function invalidCitedEvidenceIds(
  output: unknown,
  validIds: ReadonlySet<string>,
): string[] {
  const value = record(output);
  if (!value || !Array.isArray(value.hypotheses)) return [];
  const invalid = new Set<string>();
  for (const rawHypothesis of value.hypotheses) {
    const hypothesis = record(rawHypothesis);
    if (!hypothesis || !Array.isArray(hypothesis.evidenceIds)) continue;
    for (const id of hypothesis.evidenceIds) {
      if (typeof id === "string" && !validIds.has(id)) invalid.add(id);
    }
  }
  return [...invalid].sort();
}

function validationCodes(request: ModelRequest, output: unknown): string[] {
  const input = record(request.input);
  if (!input || input.runtimeVersion !== "incidentpilot-evidence-agent-v1") return [];
  const phase = input.phase;
  const ids = knownEvidenceIds(input);
  try {
    if (phase === "TRIAGE" || phase === "VERIFY") {
      const step = parseInvestigationStep(output, phase, ids);
      const artifactTargets = new Map<string, Set<string>>();
      if (Array.isArray(input.artifacts)) {
        for (const rawArtifact of input.artifacts) {
          const artifact = record(rawArtifact);
          if (!artifact || typeof artifact.kind !== "string" ||
            !Array.isArray(artifact.acceptedTargets)) continue;
          const accepted = artifact.acceptedTargets.filter(
            (target): target is string => typeof target === "string",
          );
          const existing = artifactTargets.get(artifact.kind) ?? new Set<string>();
          for (const target of accepted) existing.add(target);
          artifactTargets.set(artifact.kind, existing);
        }
      }
      const policyCodes: string[] = [];
      const toolKinds: Partial<Record<string, string>> = {
        READ_LOG_RANGE: "LOG",
        READ_DIFF: "DIFF",
        COMPARE_BASELINE: "BASELINE",
      };
      for (const toolRequest of step.toolRequests) {
        if (toolRequest.tool === "READ_LOG_RANGE" &&
          toolRequest.startLine !== null && toolRequest.endLine !== null &&
          toolRequest.endLine - toolRequest.startLine > 199) {
          policyCodes.push("TOOL_RANGE_EXCEEDS_BROKER_LIMIT");
        }
        const artifactKind = toolKinds[toolRequest.tool];
        if (artifactKind && (!toolRequest.target ||
          !artifactTargets.get(artifactKind)?.has(toolRequest.target))) {
          policyCodes.push("TOOL_TARGET_NOT_ACCEPTED");
        }
      }
      if (policyCodes.length > 0) return [...new Set(policyCodes)];
      if (phase === "VERIFY" && Array.isArray(input.completedToolRequests)) {
        const completed = new Set(input.completedToolRequests.map((entry) => JSON.stringify(entry)));
        if (step.toolRequests.some((entry) => completed.has(JSON.stringify(entry)))) {
          return ["DUPLICATE_TOOL_REQUEST"];
        }
      }
    } else if (phase === "CONCLUDE") {
      parseReadOnlyDiagnosis(output, ids);
    } else {
      return [];
    }
    return [];
  } catch (error) {
    if (error instanceof AgenticInvestigationError || error instanceof DiagnosisValidationError) {
      return [...error.codes];
    }
    return ["OUTPUT_CONTRACT_INVALID"];
  }
}

const TOOL_POLICY_CODES = new Set([
  "TOOL_RANGE_EXCEEDS_BROKER_LIMIT",
  "TOOL_TARGET_NOT_ACCEPTED",
  "DUPLICATE_TOOL_REQUEST",
]);

function suppressInvalidToolRequests(
  request: ModelRequest,
  output: unknown,
  codes: readonly string[],
): { output: unknown; suppressed: number } {
  if (codes.length === 0 || !codes.every((code) => TOOL_POLICY_CODES.has(code))) {
    return { output, suppressed: 0 };
  }
  const input = record(request.input);
  const value = record(output);
  if (!input || !value || !Array.isArray(value.toolRequests)) {
    return { output, suppressed: 0 };
  }

  const acceptedByKind = new Map<string, Set<string>>();
  if (Array.isArray(input.artifacts)) {
    for (const rawArtifact of input.artifacts) {
      const artifact = record(rawArtifact);
      if (!artifact || typeof artifact.kind !== "string" ||
        !Array.isArray(artifact.acceptedTargets)) continue;
      const accepted = acceptedByKind.get(artifact.kind) ?? new Set<string>();
      for (const target of artifact.acceptedTargets) {
        if (typeof target === "string") accepted.add(target);
      }
      acceptedByKind.set(artifact.kind, accepted);
    }
  }
  const completed = new Set(
    Array.isArray(input.completedToolRequests)
      ? input.completedToolRequests.map((entry) => JSON.stringify(entry))
      : [],
  );
  const toolKinds: Partial<Record<string, string>> = {
    READ_LOG_RANGE: "LOG",
    READ_DIFF: "DIFF",
    COMPARE_BASELINE: "BASELINE",
  };
  const retained = value.toolRequests.filter((rawRequest) => {
    const toolRequest = record(rawRequest);
    if (!toolRequest || typeof toolRequest.tool !== "string") return false;
    if (toolRequest.tool === "READ_LOG_RANGE" &&
      typeof toolRequest.startLine === "number" &&
      typeof toolRequest.endLine === "number" &&
      toolRequest.endLine - toolRequest.startLine > 199) return false;
    const kind = toolKinds[toolRequest.tool];
    if (kind && (typeof toolRequest.target !== "string" ||
      !acceptedByKind.get(kind)?.has(toolRequest.target))) return false;
    if (completed.has(JSON.stringify(rawRequest))) return false;
    return true;
  });
  const suppressed = value.toolRequests.length - retained.length;
  return suppressed === 0
    ? { output, suppressed: 0 }
    : { output: { ...value, toolRequests: retained }, suppressed };
}

function sumOptional(left: number | undefined, right: number | undefined): number | undefined {
  return left === undefined && right === undefined
    ? undefined
    : (left ?? 0) + (right ?? 0);
}

/**
 * One bounded retry for small-model contract/citation mistakes. The retry gets
 * validation codes and the authoritative id allowlist, never a silently fixed
 * output. Both physical calls are reflected in usage and attempt accounting.
 */
export class ContractRepairingModelProvider implements ModelProvider {
  constructor(private readonly delegate: ModelProvider) {}

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const first = await this.delegate.generate(request);
    const normalizedFirst = normalizeEvidenceAliases(request, first.output);
    const codes = validationCodes(request, normalizedFirst);
    if (codes.length === 0) {
      return {
        ...first,
        output: normalizedFirst,
        attempts: first.attempts ?? 1,
        attemptOutputs: first.attemptOutputs ?? [first.output],
      };
    }

    const input = record(request.input) ?? {};
    const validEvidenceIds = knownEvidenceIds(input);
    const repaired = await this.delegate.generate({
      ...request,
      input: {
        ...input,
        correction: {
          attempt: 1,
          validationCodes: codes,
          validEvidenceIds: [...validEvidenceIds].sort(),
          invalidEvidenceIdsFromRejectedOutput: invalidCitedEvidenceIds(
            normalizedFirst,
            validEvidenceIds,
          ),
          instruction:
            "Regenerate this phase from the original evidence. Correct every validation error. In hypothesis evidenceIds use only exact validEvidenceIds; artifact ids, file paths, log handles, and acceptedTargets are tool-only and must never be citations unless they also appear in validEvidenceIds. For tool target use exact artifact acceptedTargets. Keep READ_LOG_RANGE spans at 200 lines or fewer, never repeat completedToolRequests, preserve the requested phase, and return only the supplied JSON contract.",
        },
      },
    });

    const inputTokens = sumOptional(first.inputTokens, repaired.inputTokens);
    const outputTokens = sumOptional(first.outputTokens, repaired.outputTokens);
    const normalizedRepair = normalizeEvidenceAliases(request, repaired.output);
    const repairedCodes = validationCodes(request, normalizedRepair);
    const safeRepair = suppressInvalidToolRequests(request, normalizedRepair, repairedCodes);
    return {
      ...repaired,
      output: safeRepair.output,
      attempts: (first.attempts ?? 1) + (repaired.attempts ?? 1),
      attemptOutputs: [
        ...(first.attemptOutputs ?? [first.output]),
        ...(repaired.attemptOutputs ?? [repaired.output]),
      ],
      ...(inputTokens === undefined ? {} : { inputTokens }),
      ...(outputTokens === undefined ? {} : { outputTokens }),
      ...(safeRepair.suppressed === 0
        ? {}
        : { suppressedToolRequests: safeRepair.suppressed }),
      latencyMs: first.latencyMs + repaired.latencyMs,
    };
  }
}
