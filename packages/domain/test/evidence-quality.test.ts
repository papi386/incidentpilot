import { describe, expect, it } from "vitest";
import type {
  EvidenceCollectionResult,
  EvidenceDraft,
  EvidenceEdgeDraft,
} from "../src/evidence";
import {
  buildExplicitPathLinks,
  normalizeRepoRelativePath,
} from "../src/evidence-path-linker";
import {
  validateEvidenceQuality,
} from "../src/evidence-quality";
import {
  assertEvidenceRoundTrip,
} from "../src/evidence-service";

function item(
  key: string,
  kind: EvidenceDraft["kind"],
  content: string,
): EvidenceDraft {
  const derived = [
    "ERROR_SIGNAL",
    "FAILING_TEST",
    "STACK_FRAME",
  ].includes(kind);

  return {
    dedupeKey: key,
    kind,
    sourceKind: derived ? "DERIVED" : "GITHUB_API",
    integrity: derived
      ? "DERIVED_FROM_AUTHENTICATED"
      : "PROVIDER_AUTHENTICATED",
    contentClass:
      kind === "JOB_LOG_EXCERPT" ? "UNTRUSTED_TEXT" : "STRUCTURED_METADATA",
    sensitivity: "POTENTIALLY_SENSITIVE",
    instructionTrust: "NEVER_INSTRUCTIONS",
    content,
    contentSha256: "0".repeat(64),
    metadata: {},
    collectedAt: "2026-09-13T00:00:00.000Z",
  };
}

function edge(
  from: string,
  to: string,
  relation: EvidenceEdgeDraft["relation"] = "DERIVED_FROM",
): EvidenceEdgeDraft {
  return {
    fromDedupeKey: from,
    toDedupeKey: to,
    relation,
    metadata: {},
  };
}

function fixture(): EvidenceCollectionResult {
  const items = [
    item("run", "WORKFLOW_RUN", "{}"),
    item("job", "WORKFLOW_JOB", "{}"),
    item("log", "JOB_LOG_EXCERPT", "TypeError: invalid value"),
    item("error", "ERROR_SIGNAL", JSON.stringify({
      message: "invalid value",
      path: "src/api.ts",
    })),
    item("file", "CHANGED_FILE", JSON.stringify({
      filename: "src/api.ts",
    })),
  ];

  const edges = [
    edge("job", "run"),
    edge("log", "job"),
    edge("error", "log"),
    edge("file", "run"),
    edge("error", "file", "POINTS_TO_FILE"),
  ];

  return {
    items,
    edges,
    summary: {
      status: "COMPLETED",
      requestsUsed: 4,
      downloadedBytes: 100,
      itemsProduced: items.length,
      edgesProduced: edges.length,
      truncated: false,
      errorCodes: [],
      baseResolution: "HEAD_PARENT",
    },
  };
}

describe("strict path identity", () => {
  it.each([
    "../../secret",
    "/etc/passwd",
    "C:\\secret",
    "C:secret",
    "https://example.test/file",
    "file:secret",
    "\\\\server\\share",
    "src/\u0000file.ts",
  ])("rejects unsafe path %s", (path) => {
    expect(normalizeRepoRelativePath(path)).toBeNull();
  });

  it("normalizes only repository-relative syntax", () => {
    expect(normalizeRepoRelativePath("./src\\api.ts")).toBe("src/api.ts");
  });

  it("never falls back to basename matching", () => {
    expect(buildExplicitPathLinks(
      [{ id: "e", kind: "ERROR_SIGNAL", referencedPaths: ["api.ts"] }],
      [{ id: "f", path: "src/api.ts" }],
    )).toEqual([]);
  });

  it("keeps a path ambiguous after three duplicate entries", () => {
    expect(buildExplicitPathLinks(
      [{ id: "e", kind: "ERROR_SIGNAL", referencedPaths: ["src/api.ts"] }],
      [
        { id: "a", path: "src/api.ts" },
        { id: "b", path: "./src/api.ts" },
        { id: "c", path: "src\\api.ts" },
      ],
    )).toEqual([]);
  });
});

describe("evidence quality", () => {
  it("accepts a complete provenance graph", () => {
    expect(validateEvidenceQuality(fixture())).toMatchObject({
      structurallyValid: true,
      readiness: "EVIDENCE_READY",
    });
  });

  it("rejects orphan references", () => {
    const graph = fixture();
    graph.edges[0] = edge("missing", "run");
    expect(validateEvidenceQuality(graph).errors).toContain("ORPHAN_EDGE");
  });

  it("rejects unsupported file links", () => {
    const graph = fixture();
    graph.items[3]!.content = '{"message":"failure","path":"api.ts"}';
    graph.edges.push({
      fromDedupeKey: "error",
      toDedupeKey: "file",
      relation: "POINTS_TO_FILE",
      metadata: {},
    });
    graph.summary.edgesProduced = graph.edges.length;

    expect(validateEvidenceQuality(graph).errors).toContain(
      "UNSUPPORTED_FILE_REFERENCE",
    );
  });

  it("rejects provenance cycles", () => {
    const graph = fixture();
    graph.edges.push(edge("run", "error"));
    graph.summary.edgesProduced = graph.edges.length;

    expect(validateEvidenceQuality(graph).errors).toContain(
      "PROVENANCE_CYCLE",
    );
  });

  it("does not accept a derived signal without raw provenance", () => {
    const graph = fixture();
    graph.edges = graph.edges.filter(
      (entry) => entry.fromDedupeKey !== "error",
    );
    graph.summary.edgesProduced = graph.edges.length;

    expect(validateEvidenceQuality(graph).readiness).toBe(
      "EVIDENCE_INSUFFICIENT",
    );
  });

  it("downgrades a truncated graph", () => {
    const graph = fixture();
    graph.summary.truncated = true;

    expect(validateEvidenceQuality(graph).readiness).toBe(
      "EVIDENCE_PARTIAL",
    );
  });

  it("does not call metadata-only evidence ready", () => {
    const graph = fixture();
    graph.items = [graph.items[0]!];
    graph.edges = [];
    graph.summary.itemsProduced = 1;
    graph.summary.edgesProduced = 0;

    expect(validateEvidenceQuality(graph).readiness).toBe(
      "EVIDENCE_INSUFFICIENT",
    );
  });

  it("detects changed content after persistence read-back", () => {
    const expected = fixture();
    const loaded = structuredClone(expected);
    loaded.items[2]!.content = "different content";

    expect(() => assertEvidenceRoundTrip(expected, loaded)).toThrow(
      "EVIDENCE_ROUND_TRIP_MISMATCH",
    );
  });

  it("allows storage to return items in another order", () => {
    const expected = fixture();
    const loaded = structuredClone(expected);
    loaded.items.reverse();
    loaded.edges.reverse();

    expect(() => assertEvidenceRoundTrip(expected, loaded)).not.toThrow();
  });
});
