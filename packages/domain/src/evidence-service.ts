import type {
  EvidenceCollectionResult,
  EvidenceCollectionSummary,
  EvidenceDraft,
  EvidenceEdgeDraft,
  StoredEvidenceCollection,
} from "./evidence";

import type {
  AuditLog,
  EvidenceSource,
  EvidenceStore,
  IncidentContextStore,
} from "./ports";

import {
  edgeIdentity,
  exactFileEdges,
  structuredContent,
  validateEvidenceQuality,
} from "./evidence-quality";

const MAX_EVIDENCE_EDGES = 96;

export function augmentEvidenceGraph(
  result: EvidenceCollectionResult,
): EvidenceCollectionResult {
  const items = [...result.items];

  // Rebuild file links through the strict exact-path policy.
  const edges = result.edges.filter(
    (edge) => edge.relation !== "POINTS_TO_FILE",
  );

  const existingEdges = new Set(edges.map(edgeIdentity));
  let truncated = result.summary.truncated;

  function addEdge(edge: EvidenceEdgeDraft): void {
    const identity = edgeIdentity(edge);

    if (existingEdges.has(identity)) {
      return;
    }

    if (edges.length >= MAX_EVIDENCE_EDGES) {
      truncated = true;
      return;
    }

    existingEdges.add(identity);
    edges.push(edge);
  }

  const roots = items.filter(
    (item) =>
      item.kind === "WORKFLOW_RUN" ||
      item.kind === "CHECK_RUN",
  );

  // Never guess which root owns a changeset.
  if (roots.length === 1) {
    const root = roots[0]!;

    for (const file of items) {
      if (file.kind !== "CHANGED_FILE") {
        continue;
      }

      addEdge({
        fromDedupeKey: file.dedupeKey,
        toDedupeKey: root.dedupeKey,
        relation: "DERIVED_FROM",
        metadata: {
          reason:
            root.kind === "WORKFLOW_RUN"
              ? "WORKFLOW_CHANGESET"
              : "CHECK_CHANGESET",
        },
      });
    }
  }

  for (const edge of exactFileEdges(items)) {
    addEdge(edge);
  }

  const parserTruncated = items.some(
    (item) =>
      item.sourceKind === "DERIVED" &&
      structuredContent(item).parserTruncated === 1,
  );

  truncated ||= parserTruncated;

  return {
    items,
    edges,
    summary: {
      ...result.summary,
      itemsProduced: items.length,
      edgesProduced: edges.length,
      truncated,
      status:
        result.summary.status === "COMPLETED" && truncated
          ? "PARTIAL"
          : result.summary.status,
    },
  };
}

async function verifyContentHashes(
  items: readonly EvidenceDraft[],
): Promise<void> {
  for (const item of items) {
    const digest = new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(item.content),
      ),
    );

    const actual = Array.from(
      digest,
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");

    if (actual !== item.contentSha256) {
      throw new Error("EVIDENCE_CONTENT_HASH_MISMATCH");
    }
  }
}

/**
 * Stable serialization for comparing the plaintext evidence contract.
 *
 * Object key order and database row order are irrelevant.
 * Array order inside an evidence payload remains significant.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);

    if (encoded === undefined) {
      throw new Error("INVALID_EVIDENCE_VALUE");
    }

    return encoded;
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  const object = value as Record<string, unknown>;

  const entries = Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJson(object[key])}`,
    );

  return `{${entries.join(",")}}`;
}

/**
 * Verify that persisted and decrypted evidence matches the intended
 * snapshot, including security metadata and edge metadata.
 *
 * This comparison does not replace cryptographic authentication:
 * EvidenceStore.loadCollection() must perform authenticated decryption.
 */
export function assertEvidenceRoundTrip(
  expected: StoredEvidenceCollection,
  actual: StoredEvidenceCollection,
): void {
  function snapshot(
    collection: StoredEvidenceCollection,
  ): string {
    return canonicalJson({
      items: collection.items.map(canonicalJson).sort(),
      edges: collection.edges.map(canonicalJson).sort(),
    });
  }

  if (snapshot(expected) !== snapshot(actual)) {
    // Never include decrypted evidence in an error message.
    throw new Error("EVIDENCE_ROUND_TRIP_MISMATCH");
  }
}

export class EvidenceService {
  constructor(
    private readonly contexts: IncidentContextStore,
    private readonly source: EvidenceSource,
    private readonly evidence: EvidenceStore,
    private readonly audit: AuditLog,
  ) {}

  async collect(
    incidentId: string,
  ): Promise<EvidenceCollectionSummary> {
    const context =
      await this.contexts.getEvidenceContext(incidentId);

    if (!context) {
      throw new Error("INCIDENT_EVIDENCE_CONTEXT_MISSING");
    }

    const startedAt = new Date().toISOString();

    const result = augmentEvidenceGraph(
      await this.source.collect(context),
    );

    const quality = validateEvidenceQuality(result);

    // Empty failed collections can still be recorded for diagnosis.
    // Any nonempty malformed graph is rejected before persistence.
    if (
      !quality.structurallyValid &&
      (result.items.length > 0 || result.edges.length > 0)
    ) {
      throw new Error("EVIDENCE_GRAPH_INVALID");
    }

    await verifyContentHashes(result.items);

    const expectedRootKind =
      context.triggerType === "GITHUB_WORKFLOW_RUN"
        ? "WORKFLOW_RUN"
        : context.triggerType === "GITHUB_CHECK_RUN"
          ? "CHECK_RUN"
          : undefined;

    if (result.items.length > 0) {
      const root = result.items.find(
        (item) => item.kind === expectedRootKind,
      );

      if (
        !expectedRootKind ||
        !root ||
        root.sourceExternalId !== context.triggerExternalId
      ) {
        throw new Error("EVIDENCE_ROOT_IDENTITY_MISMATCH");
      }
    }

    const summary: EvidenceCollectionSummary = {
      ...result.summary,
      status:
        quality.readiness === "EVIDENCE_INSUFFICIENT"
          ? "FAILED"
          : quality.readiness === "EVIDENCE_PARTIAL"
            ? "PARTIAL"
            : result.summary.status,
      errorCodes: [
        ...new Set([
          ...result.summary.errorCodes,
          ...(quality.readiness === "EVIDENCE_INSUFFICIENT"
            ? ["EVIDENCE_INSUFFICIENT"]
            : []),
        ]),
      ],
    };

    const completedAt = new Date().toISOString();

    await this.evidence.saveCollection(
      {
        idempotencyKey:
          `evidence-collection:github:${incidentId}`,
        incidentId,
        source: "github",
        startedAt,
        completedAt,
        summary,
      },
      result.items,
      result.edges,
    );

    // Verify through the actual trusted storage/decryption adapter.
    const reloaded =
      await this.evidence.loadCollection(incidentId);

    assertEvidenceRoundTrip(result, reloaded);

    // Report successful verification only after read-back completes.
    await this.audit.append({
      idempotencyKey:
        `evidence-collected:${incidentId}:github`,
      incidentId,
      actorType: "SYSTEM",
      actorId: "evidence-engine",
      eventType: "EVIDENCE_COLLECTION_COMPLETED",
      occurredAt: new Date().toISOString(),
      metadata: {
        status: summary.status,
        requestsUsed: summary.requestsUsed,
        downloadedBytes: summary.downloadedBytes,
        itemsProduced: summary.itemsProduced,
        edgesProduced: summary.edgesProduced,
        truncated: summary.truncated,
        errorCount: summary.errorCodes.length,
        baseResolution: summary.baseResolution,
        qualityVersion: quality.version,
        readiness: quality.readiness,
       qualityErrorsJson: JSON.stringify(quality.errors),
limitationsJson: JSON.stringify(quality.limitations),
        persistenceVerified: true,
      },
    });

    return summary;
  }
}