import type { EvidenceCollectionResult, EvidenceDraft } from "./evidence";

export type CausalNodeKind =
  | "INPUT_CHANGE"
  | "CACHE_RESTORE"
  | "INSTALL_FAILURE"
  | "GENERATED_ARTIFACT_STALE"
  | "COMPILATION_FAILURE"
  | "TEST_FAILURE"
  | "RUNTIME_FAILURE"
  | "DOWNSTREAM_FAILURE";

export type CausalRelation =
  | "PRECEDES"
  | "CAUSES"
  | "INVALIDATES"
  | "DOWNSTREAM_OF";

export interface CausalIncidentNode {
  id: string;
  kind: CausalNodeKind;
  sequence: number;
  summary: string;
  evidenceIds: string[];
  confidence: number;
}

export interface CausalIncidentEdge {
  from: string;
  to: string;
  relation: CausalRelation;
}

export interface CausalEvidenceClassification {
  evidenceId: string;
  classification:
    | "ROOT_CAUSE_SIGNAL"
    | "CONTRIBUTING_SIGNAL"
    | "DOWNSTREAM_SYMPTOM"
    | "UNRESOLVED";
  reason: string;
}

export interface CausalIncidentAnalysis {
  version: "incidentpilot-causal-graph-v1";
  nodes: CausalIncidentNode[];
  edges: CausalIncidentEdge[];
  firstFailureNodeId: string | null;
  classifications: CausalEvidenceClassification[];
  signals: string[];
}

function structured(item: EvidenceDraft): Record<string, unknown> {
  if (item.contentClass !== "STRUCTURED_METADATA") return {};
  try {
    const value: unknown = JSON.parse(item.content);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

/**
 * Builds a compact causal graph from typed evidence. It does not diagnose the
 * incident. It establishes temporal/dependency facts that models may audit and
 * that deterministic gates may use to distinguish causes from symptoms.
 */
export function buildCausalIncidentAnalysis(
  evidence: EvidenceCollectionResult,
): CausalIncidentAnalysis {
  const nodes: CausalIncidentNode[] = [];
  const edges: CausalIncidentEdge[] = [];
  const classifications: CausalEvidenceClassification[] = [];
  const signals = new Set<string>();
  let sequence = 0;

  const addNode = (
    id: string,
    kind: CausalNodeKind,
    summary: string,
    evidenceIds: string[],
    confidence: number,
  ): CausalIncidentNode => {
    const existing = nodes.find((entry) => entry.id === id);
    if (existing) return existing;
    const node = { id, kind, sequence: ++sequence, summary, evidenceIds, confidence };
    nodes.push(node);
    return node;
  };

  const schemaChanges = evidence.items.filter((item) =>
    item.kind === "DIFF_HUNK" &&
    /schema|prisma|openapi|graphql|proto/iu
      .test(`${String(item.metadata.path ?? "")} ${item.content}`)
  );
  const cacheRestores = evidence.items.filter((item) =>
    /cache hit|"cacheHit"\s*:\s*true|cached output/iu.test(item.content)
  );
  const omittedInputs = evidence.items.filter((item) =>
    /omittedInput|cachedSchemaRevision|currentSchemaRevision/iu.test(item.content)
  );
  const generatedContractErrors = evidence.items.filter((item) =>
    /(?:property|field|member).{0,100}(?:does not exist|missing)|(?:does not exist|missing).{0,100}(?:property|field|member)/iu
      .test(item.content)
  );
  const installFailures = evidence.items.filter((item) =>
    /npm ci|pnpm install|yarn install/iu.test(item.content) &&
    /failed|error|lock|sync/iu.test(item.content)
  );

  const inputNodes = schemaChanges.map((item) =>
    addNode(
      `input-change:${item.dedupeKey}`,
      "INPUT_CHANGE",
      "A generator input changed in the failed revision.",
      [item.dedupeKey],
      0.95,
    )
  );
  const cacheNodes = cacheRestores.map((item) =>
    addNode(
      `cache-restore:${item.dedupeKey}`,
      "CACHE_RESTORE",
      "A build or generation task reused cached output.",
      [item.dedupeKey],
      0.9,
    )
  );
  const installNodes = installFailures.map((item) =>
    addNode(
      `install-failure:${item.dedupeKey}`,
      "INSTALL_FAILURE",
      "Dependency installation failed before later build or test work.",
      [item.dedupeKey],
      0.9,
    )
  );

  const primaryFailureNodes: CausalIncidentNode[] = [];
  const downstreamNodes: CausalIncidentNode[] = [];
  for (const item of evidence.items) {
    if (item.kind !== "ERROR_SIGNAL" && item.kind !== "FAILING_TEST") continue;
    const content = structured(item);
    const text = `${item.content} ${String(content.message ?? "")}`;
    const explicitlyDownstream = typeof content.downstreamOf === "string" ||
      /downstream|build output (?:was )?not produced|skipped because|cannot find module ['"]?dist/iu
        .test(text);
    const kind: CausalNodeKind = explicitlyDownstream
      ? "DOWNSTREAM_FAILURE"
      : item.kind === "FAILING_TEST"
      ? "TEST_FAILURE"
      : /TS\d{4}|compile|type/iu.test(text)
      ? "COMPILATION_FAILURE"
      : "RUNTIME_FAILURE";
    const node = addNode(
      `failure:${item.dedupeKey}`,
      kind,
      typeof content.message === "string" ? content.message : item.content.slice(0, 300),
      [item.dedupeKey],
      explicitlyDownstream ? 0.95 : 0.8,
    );
    classifications.push({
      evidenceId: item.dedupeKey,
      classification: explicitlyDownstream ? "DOWNSTREAM_SYMPTOM" : "CONTRIBUTING_SIGNAL",
      reason: explicitlyDownstream
        ? "The evidence explicitly depends on an earlier failed phase or missing output."
        : "The signal is a candidate failure but requires causal localization.",
    });
    (explicitlyDownstream ? downstreamNodes : primaryFailureNodes).push(node);
  }

  if (
    schemaChanges.length > 0 && cacheRestores.length > 0 &&
    omittedInputs.length > 0 && generatedContractErrors.length > 0
  ) {
    const stale = addNode(
      "cause:stale-generated-artifact",
      "GENERATED_ARTIFACT_STALE",
      "Cached generated output was reused after an omitted generator input changed.",
      [...new Set([
        ...schemaChanges.map((item) => item.dedupeKey),
        ...cacheRestores.map((item) => item.dedupeKey),
        ...omittedInputs.map((item) => item.dedupeKey),
        ...generatedContractErrors.map((item) => item.dedupeKey),
      ])],
      0.97,
    );
    inputNodes.forEach((node) => edges.push({ from: node.id, to: stale.id, relation: "INVALIDATES" }));
    cacheNodes.forEach((node) => edges.push({ from: node.id, to: stale.id, relation: "CAUSES" }));
    primaryFailureNodes.forEach((node) => edges.push({ from: stale.id, to: node.id, relation: "CAUSES" }));
    classifications.push(...stale.evidenceIds.map((evidenceId) => ({
      evidenceId,
      classification: "ROOT_CAUSE_SIGNAL" as const,
      reason: "The evidence participates in a complete stale-artifact causal chain.",
    })));
    signals.add("STALE_GENERATED_ARTIFACT_CAUSAL_CHAIN");
  }

  const causalParents = nodes.filter((node) =>
    node.kind === "GENERATED_ARTIFACT_STALE" || node.kind === "INSTALL_FAILURE"
  );
  for (const downstream of downstreamNodes) {
    const parent = causalParents[0] ?? primaryFailureNodes[0];
    if (parent) {
      edges.push({ from: parent.id, to: downstream.id, relation: "DOWNSTREAM_OF" });
    }
  }
  if (downstreamNodes.length > 0) signals.add("DOWNSTREAM_FAILURES_CLASSIFIED");
  if (installNodes.length > 0) signals.add("INSTALL_FAILURE_PRECEDES_DOWNSTREAM_WORK");

  const firstFailure = nodes.find((node) => node.kind === "GENERATED_ARTIFACT_STALE") ??
    installNodes[0] ?? primaryFailureNodes[0] ?? null;

  return {
    version: "incidentpilot-causal-graph-v1",
    nodes,
    edges,
    firstFailureNodeId: firstFailure?.id ?? null,
    classifications: [...new Map(
      classifications.map((entry) => [`${entry.evidenceId}:${entry.classification}`, entry]),
    ).values()],
    signals: [...signals].sort(),
  };
}
