import {
  EVIDENCE_CONTENT_CLASSES,
  EVIDENCE_INTEGRITY,
  EVIDENCE_KINDS,
  EVIDENCE_SENSITIVITY,
  EVIDENCE_SOURCE_KINDS,
} from "./evidence";

import type {
  EvidenceCollectionResult,
  EvidenceDraft,
  EvidenceEdgeDraft,
} from "./evidence";

import { buildExplicitPathLinks } from "./evidence-path-linker";

export type EvidenceReadiness =
  | "EVIDENCE_READY"
  | "EVIDENCE_PARTIAL"
  | "EVIDENCE_INSUFFICIENT";

export interface EvidenceQuality {
  version: 1;
  structurallyValid: boolean;
  readiness: EvidenceReadiness;
  errors: string[];
  limitations: string[];
}

const MAX_ITEMS = 48;
const MAX_EDGES = 96;
const MAX_REQUESTS = 16;
const MAX_LOG_BYTES = 768 * 1024;

const SIGNAL_KINDS = new Set<string>([
  "FAILING_TEST",
  "ERROR_SIGNAL",
  "STACK_FRAME",
]);

const ROOT_KINDS = new Set<string>([
  "WORKFLOW_RUN",
  "CHECK_RUN",
]);

const DERIVATION_PAIRS = new Set([
  "WORKFLOW_JOB:WORKFLOW_RUN",
  "JOB_LOG_EXCERPT:WORKFLOW_JOB",
  "CHECK_OUTPUT:CHECK_RUN",
  "FAILING_TEST:JOB_LOG_EXCERPT",
  "ERROR_SIGNAL:JOB_LOG_EXCERPT",
  "STACK_FRAME:JOB_LOG_EXCERPT",
  "FAILING_TEST:CHECK_OUTPUT",
  "ERROR_SIGNAL:CHECK_OUTPUT",
  "STACK_FRAME:CHECK_OUTPUT",
  "CHANGED_FILE:WORKFLOW_RUN",
  "CHANGED_FILE:CHECK_RUN",
  "DIFF_HUNK:CHANGED_FILE",
]);

function member(
  values: readonly string[],
  value: unknown,
): boolean {
  return typeof value === "string" && values.includes(value);
}

function positiveInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0
  );
}

function nonnegativeInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

export function structuredContent(
  item: EvidenceDraft,
): Record<string, unknown> {
  if (item.contentClass !== "STRUCTURED_METADATA") {
    return {};
  }

  try {
    const value: unknown = JSON.parse(item.content);

    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value)
    ) {
      return {};
    }

    return value as Record<string, unknown>;
  } catch {
    return {};
  }
}

function hasValidStructuredContent(item: EvidenceDraft): boolean {
  if (item.contentClass !== "STRUCTURED_METADATA") {
    return true;
  }

  try {
    const value: unknown = JSON.parse(item.content);

    return (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value)
    );
  } catch {
    return false;
  }
}

export function exactFileEdges(
  items: readonly EvidenceDraft[],
): EvidenceEdgeDraft[] {
  const sources = items.flatMap((item) => {
    if (
      item.kind !== "ERROR_SIGNAL" &&
      item.kind !== "FAILING_TEST" &&
      item.kind !== "STACK_FRAME"
    ) {
      return [];
    }

    const content = structuredContent(item);

    return [{
      id: item.dedupeKey,
      kind: item.kind,
      referencedPaths:
        typeof content.path === "string"
          ? [content.path]
          : [],
    }];
  });

  const files = items.flatMap((item) => {
    if (item.kind !== "CHANGED_FILE") {
      return [];
    }

    const content = structuredContent(item);

    return typeof content.filename === "string"
      ? [{
          id: item.dedupeKey,
          path: content.filename,
        }]
      : [];
  });

  return buildExplicitPathLinks(sources, files).map((link) => ({
    fromDedupeKey: link.fromEvidenceId,
    toDedupeKey: link.toEvidenceId,
    relation: "POINTS_TO_FILE",
    metadata: {
      reason: "EXACT_REPOSITORY_PATH",
    },
  }));
}

export function edgeIdentity(edge: EvidenceEdgeDraft): string {
  return JSON.stringify([
    edge.fromDedupeKey,
    edge.relation,
    edge.toDedupeKey,
  ]);
}

function isAuthenticated(item: EvidenceDraft): boolean {
  return (
    item.sourceKind !== "DERIVED" &&
    member(EVIDENCE_SOURCE_KINDS, item.sourceKind) &&
    item.integrity === "PROVIDER_AUTHENTICATED"
  );
}

/**
 * Numbered log excerpts use original source-line numbers.
 * CHECK_OUTPUT currently uses ordinary lines numbered from one.
 *
 * Duplicate or malformed excerpt numbering is rejected.
 */
function retainedLineNumbers(
  source: EvidenceDraft,
): Set<number> | null {
  const lines = source.content.replace(/\r\n?/gu, "\n").split("\n");

  if (source.kind === "CHECK_OUTPUT") {
    return new Set(lines.map((_, index) => index + 1));
  }

  const result = new Set<number>();

  for (const line of lines) {
    const match = line.match(/^(\d+): /u);
    if (!match) return null;

    const number = Number(match[1]);

    if (!positiveInteger(number) || result.has(number)) {
      return null;
    }

    result.add(number);
  }

  return result;
}

function validSourceRange(
  item: EvidenceDraft,
  parents: readonly EvidenceDraft[],
): boolean {
  const content = structuredContent(item);
  const start = content.sourceLineStart;
  const end = content.sourceLineEnd;

  if (
    !positiveInteger(start) ||
    !positiveInteger(end) ||
    end < start ||
    end - start >= 1_000
  ) {
    return false;
  }

  const rawParents = parents.filter(
    (parent) =>
      parent.kind === "JOB_LOG_EXCERPT" ||
      parent.kind === "CHECK_OUTPUT",
  );

  // Parser output must identify one source excerpt unambiguously.
  if (rawParents.length !== 1) return false;

  const source = rawParents[0];
  if (!source) return false;

  const retained = retainedLineNumbers(source);
  if (!retained) return false;

  for (let number = start; number <= end; number += 1) {
    if (!retained.has(number)) return false;
  }

  return true;
}

function usefulDiagnostic(item: EvidenceDraft): boolean {
  const content = structuredContent(item);

  if (item.kind === "FAILING_TEST") {
    return (
      typeof content.test === "string" &&
      content.test.trim().length > 0
    );
  }

  if (item.kind === "ERROR_SIGNAL") {
    return (
      typeof content.message === "string" &&
      content.message.trim().length > 0
    );
  }

  return false;
}

interface GraphAssessment {
  errors: Set<string>;
  limitations: Set<string>;
  root: EvidenceDraft | undefined;
  byKey: Map<string, EvidenceDraft>;
  parents: Map<string, string[]>;
}

function assessGraph(
  result: EvidenceCollectionResult,
): GraphAssessment {
  const errors = new Set<string>();
  const limitations = new Set<string>();
  const byKey = new Map<string, EvidenceDraft>();
  const parents = new Map<string, string[]>();

  const graph: GraphAssessment = {
    errors,
    limitations,
    root: undefined,
    byKey,
    parents,
  };

  // Return early before graph traversal on oversized input.
  if (
    result.items.length > MAX_ITEMS ||
    result.edges.length > MAX_EDGES
  ) {
    errors.add("GRAPH_BUDGET_EXCEEDED");
    return graph;
  }

  const summary = result.summary;

  if (
    summary.itemsProduced !== result.items.length ||
    summary.edgesProduced !== result.edges.length
  ) {
    errors.add("SUMMARY_COUNT_MISMATCH");
  }

  if (
    !nonnegativeInteger(summary.requestsUsed) ||
    !nonnegativeInteger(summary.downloadedBytes) ||
    summary.requestsUsed > MAX_REQUESTS ||
    summary.downloadedBytes > MAX_LOG_BYTES
  ) {
    errors.add("COLLECTION_BUDGET_INVALID");
  }

  if (
    !["COMPLETED", "PARTIAL", "FAILED"].includes(summary.status) ||
    typeof summary.truncated !== "boolean"
  ) {
    errors.add("INVALID_COLLECTION_SUMMARY");
  }

  for (const item of result.items) {
    if (!item.dedupeKey || byKey.has(item.dedupeKey)) {
      errors.add("DUPLICATE_OR_EMPTY_EVIDENCE_ID");
    }

    byKey.set(item.dedupeKey, item);

    if (
      !member(EVIDENCE_KINDS, item.kind) ||
      !member(EVIDENCE_SOURCE_KINDS, item.sourceKind) ||
      !member(EVIDENCE_INTEGRITY, item.integrity) ||
      !member(EVIDENCE_CONTENT_CLASSES, item.contentClass) ||
      !member(EVIDENCE_SENSITIVITY, item.sensitivity)
    ) {
      errors.add("INVALID_EVIDENCE_CLASSIFICATION");
    }

    if (item.instructionTrust !== "NEVER_INSTRUCTIONS") {
      errors.add("INVALID_INSTRUCTION_TRUST");
    }

    if (
      (item.sourceKind === "DERIVED") !==
      (item.integrity === "DERIVED_FROM_AUTHENTICATED")
    ) {
      errors.add("INVALID_DERIVATION_INTEGRITY");
    }

    if (
      SIGNAL_KINDS.has(item.kind) &&
      item.sourceKind !== "DERIVED"
    ) {
      errors.add("FAILURE_SIGNAL_NOT_DERIVED");
    }

    if (!hasValidStructuredContent(item)) {
      errors.add("INVALID_STRUCTURED_CONTENT");
    }

    if (structuredContent(item).parserTruncated === 1) {
      limitations.add("PARSER_TRUNCATED");
    }

    const injection = item.metadata.injectionSignals;
    if (Array.isArray(injection) && injection.length > 0) {
      limitations.add("INJECTION_SIGNALS_PRESENT");
    }
  }

  const roots = result.items.filter(
    (item) => ROOT_KINDS.has(item.kind),
  );

  if (roots.length > 1) {
    errors.add("CANONICAL_ROOT_COUNT_INVALID");
  } else if (roots.length === 0) {
    limitations.add("CANONICAL_ROOT_UNAVAILABLE");
  } else {
    graph.root = roots[0];
  }

  if (graph.root && !isAuthenticated(graph.root)) {
    errors.add("ROOT_NOT_PROVIDER_AUTHENTICATED");
  }

  const permittedReferences = new Set(
    exactFileEdges(result.items).map(edgeIdentity),
  );

  const seen = new Set<string>();

  for (const edge of result.edges) {
    const identity = edgeIdentity(edge);

    if (seen.has(identity)) errors.add("DUPLICATE_EDGE");
    seen.add(identity);

    const from = byKey.get(edge.fromDedupeKey);
    const to = byKey.get(edge.toDedupeKey);

    if (!from || !to) {
      errors.add("ORPHAN_EDGE");
      continue;
    }

    if (from.dedupeKey === to.dedupeKey) {
      errors.add("SELF_EDGE");
      continue;
    }

    if (edge.relation === "DERIVED_FROM") {
      if (!DERIVATION_PAIRS.has(`${from.kind}:${to.kind}`)) {
        errors.add("INVALID_DERIVATION_RELATION");
        continue;
      }

      const entries = parents.get(from.dedupeKey) ?? [];
      entries.push(to.dedupeKey);
      parents.set(from.dedupeKey, entries);
    } else if (edge.relation === "POINTS_TO_FILE") {
      if (!permittedReferences.has(identity)) {
        errors.add("UNSUPPORTED_FILE_REFERENCE");
      }
    } else {
      errors.add("UNSUPPORTED_RELATION");
    }
  }

  // Detect cycles independently of permitted relation pairs.
  const allParents = new Map<string, string[]>();

  for (const edge of result.edges) {
    if (edge.relation !== "DERIVED_FROM") continue;
    if (!byKey.has(edge.fromDedupeKey) || !byKey.has(edge.toDedupeKey)) {
      continue;
    }

    const entries = allParents.get(edge.fromDedupeKey) ?? [];
    entries.push(edge.toDedupeKey);
    allParents.set(edge.fromDedupeKey, entries);
  }

  const active = new Set<string>();
  const complete = new Set<string>();

  function visit(key: string): void {
    if (active.has(key)) {
      errors.add("PROVENANCE_CYCLE");
      return;
    }

    if (complete.has(key)) return;

    active.add(key);
    for (const parent of allParents.get(key) ?? []) visit(parent);
    active.delete(key);
    complete.add(key);
  }

  for (const key of byKey.keys()) visit(key);

  return graph;
}

function reaches(
  start: string,
  graph: GraphAssessment,
  predicate: (item: EvidenceDraft) => boolean,
): boolean {
  const pending = [start];
  const visited = new Set<string>();

  while (pending.length > 0) {
    const key = pending.pop();
    if (key === undefined || visited.has(key)) continue;

    visited.add(key);

    const item = graph.byKey.get(key);
    if (item && predicate(item)) return true;

    pending.push(...(graph.parents.get(key) ?? []));
  }

  return false;
}

export function validateEvidenceQuality(
  result: EvidenceCollectionResult,
): EvidenceQuality {
  const graph = assessGraph(result);
  const { errors, limitations } = graph;

  if (errors.has("GRAPH_BUDGET_EXCEEDED")) {
    return {
      version: 1,
      structurallyValid: false,
      readiness: "EVIDENCE_INSUFFICIENT",
      errors: [...errors],
      limitations: [],
    };
  }

  let usefulRootedDiagnostics = 0;

  for (const item of result.items) {
    const rooted = reaches(
      item.dedupeKey,
      graph,
      (candidate) => candidate.dedupeKey === graph.root?.dedupeKey,
    );

    if (!rooted) {
      limitations.add("DISCONNECTED_PROVENANCE");
    }

    if (
      item.sourceKind === "DERIVED" &&
      !reaches(item.dedupeKey, graph, isAuthenticated)
    ) {
      errors.add("MISSING_AUTHENTICATED_PROVENANCE");
    }

    if (SIGNAL_KINDS.has(item.kind)) {
      const parentItems = (graph.parents.get(item.dedupeKey) ?? [])
        .flatMap((key) => {
          const parent = graph.byKey.get(key);
          return parent ? [parent] : [];
        });

      const hasRawParent = parentItems.some(
        (parent) =>
          (parent.kind === "JOB_LOG_EXCERPT" ||
            parent.kind === "CHECK_OUTPUT") &&
          parent.content.trim().length > 0,
      );

      if (!hasRawParent) {
        errors.add("MISSING_DIAGNOSTIC_SOURCE");
      }

      const content = structuredContent(item);

      if (
        typeof content.parserVersion === "number" &&
        content.parserVersion >= 2 &&
        !validSourceRange(item, parentItems)
      ) {
        errors.add("INVALID_DIAGNOSTIC_SOURCE_RANGE");
      }

      if (rooted && hasRawParent && usefulDiagnostic(item)) {
        usefulRootedDiagnostics += 1;
      }
    }
  }

  if (usefulRootedDiagnostics === 0) {
    limitations.add("NO_ROOTED_FAILURE_DIAGNOSTIC");
  }

  const rootedChanges = result.items.some(
    (item) =>
      item.kind === "CHANGED_FILE" &&
      reaches(
        item.dedupeKey,
        graph,
        (candidate) => candidate.dedupeKey === graph.root?.dedupeKey,
      ),
  );

  if (!rootedChanges) {
    limitations.add("CHANGE_CONTEXT_UNAVAILABLE");
  }

  const fileReferences = result.edges.some(
    (edge) => edge.relation === "POINTS_TO_FILE",
  );

  // Absence is reported only when diagnostics explicitly claim a path.
  // It does not force every useful diagnostic to name a file.
  const explicitPaths = result.items.some(
    (item) =>
      SIGNAL_KINDS.has(item.kind) &&
      typeof structuredContent(item).path === "string",
  );

  if (explicitPaths && !fileReferences) {
    limitations.add("EXPLICIT_PATH_WITHOUT_COLLECTED_MATCH");
  }

  if (result.summary.truncated) {
    limitations.add("COLLECTION_TRUNCATED");
  }

  if (result.summary.status !== "COMPLETED") {
    limitations.add("COLLECTION_NOT_COMPLETE");
  }

  if (result.summary.errorCodes.length > 0) {
    limitations.add("COLLECTOR_REPORTED_ERRORS");
  }

  const insufficient =
    errors.size > 0 ||
    !graph.root ||
    usefulRootedDiagnostics === 0 ||
    result.summary.status === "FAILED";

  return {
    version: 1,
    structurallyValid: errors.size === 0,
    readiness: insufficient
      ? "EVIDENCE_INSUFFICIENT"
      : limitations.size > 0
        ? "EVIDENCE_PARTIAL"
        : "EVIDENCE_READY",
    errors: [...errors].sort(),
    limitations: [...limitations].sort(),
  };
}