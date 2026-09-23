import {
  describe,
  expect,
  it,
} from "vitest";

import {
  augmentEvidenceGraph,
} from "../src/evidence-service";

import type {
  EvidenceCollectionResult,
  EvidenceDraft,
  EvidenceEdgeDraft,
} from "../src/evidence";

function evidence(
  dedupeKey: string,
  kind: EvidenceDraft["kind"],
): EvidenceDraft {
  return {
    dedupeKey,
    kind,

    sourceKind:
      kind === "ERROR_SIGNAL" ||
      kind === "FAILING_TEST"
        ? "DERIVED"
        : "GITHUB_API",

    integrity:
      kind === "ERROR_SIGNAL" ||
      kind === "FAILING_TEST"
        ? "DERIVED_FROM_AUTHENTICATED"
        : "PROVIDER_AUTHENTICATED",

    contentClass:
      kind === "DIFF_HUNK" ||
      kind === "JOB_LOG_EXCERPT"
        ? "UNTRUSTED_TEXT"
        : "STRUCTURED_METADATA",

    sensitivity:
      kind === "DIFF_HUNK" ||
      kind === "JOB_LOG_EXCERPT" ||
      kind === "ERROR_SIGNAL" ||
      kind === "FAILING_TEST"
        ? "POTENTIALLY_SENSITIVE"
        : "NORMAL",

    instructionTrust:
      "NEVER_INSTRUCTIONS",

    content: "{}",

    contentSha256:
      "0".repeat(64),

    metadata: {},

    collectedAt:
      "2026-09-13T00:00:00.000Z",
  };
}

function edge(
  fromDedupeKey: string,
  toDedupeKey: string,
): EvidenceEdgeDraft {
  return {
    fromDedupeKey,
    toDedupeKey,

    relation:
      "DERIVED_FROM",

    metadata: {},
  };
}

function baseResult(): EvidenceCollectionResult {
  const items = [
    evidence(
      "workflow-run",
      "WORKFLOW_RUN",
    ),

    evidence(
      "workflow-job",
      "WORKFLOW_JOB",
    ),

    evidence(
      "job-log",
      "JOB_LOG_EXCERPT",
    ),

    evidence(
      "failing-test",
      "FAILING_TEST",
    ),

    evidence(
      "error-signal",
      "ERROR_SIGNAL",
    ),

    evidence(
      "changed-file",
      "CHANGED_FILE",
    ),

    evidence(
      "diff-hunk",
      "DIFF_HUNK",
    ),
  ];

  const edges = [
    edge(
      "workflow-job",
      "workflow-run",
    ),

    edge(
      "job-log",
      "workflow-job",
    ),

    edge(
      "failing-test",
      "job-log",
    ),

    edge(
      "error-signal",
      "job-log",
    ),

    edge(
      "diff-hunk",
      "changed-file",
    ),
  ];

  return {
    items,
    edges,

    summary: {
      status: "COMPLETED",

      requestsUsed: 7,
      downloadedBytes: 20_144,

      itemsProduced: 7,
      edgesProduced: 5,

      truncated: false,

      errorCodes: [],

      baseResolution:
        "HEAD_PARENT",
    },
  };
}

describe(
  "augmentEvidenceGraph",
  () => {
    it(
      "connects changed files to the canonical workflow run through provenance",
      () => {
        const result =
          augmentEvidenceGraph(
            baseResult(),
          );

        expect(
          result.edges,
        ).toContainEqual({
          fromDedupeKey:
            "changed-file",

          toDedupeKey:
            "workflow-run",

          relation:
            "DERIVED_FROM",

          metadata: {
            reason:
              "WORKFLOW_CHANGESET",
          },
        });

        expect(
          result.summary.itemsProduced,
        ).toBe(7);

        expect(
          result.summary.edgesProduced,
        ).toBe(6);

        expect(
          result.summary.truncated,
        ).toBe(false);
      },
    );

    it(
      "produces the expected Python reference topology",
      () => {
        const result =
          augmentEvidenceGraph(
            baseResult(),
          );

        const itemKind =
          new Map(
            result.items.map(
              (item) => [
                item.dedupeKey,
                item.kind,
              ],
            ),
          );

        const relationships =
          result.edges
            .map(
              (graphEdge) =>
                `${
                  itemKind.get(
                    graphEdge.fromDedupeKey,
                  )
                }:${
                  graphEdge.relation
                }:${
                  itemKind.get(
                    graphEdge.toDedupeKey,
                  )
                }`,
            )
            .sort();

        expect(
          relationships,
        ).toEqual(
          [
            "CHANGED_FILE:DERIVED_FROM:WORKFLOW_RUN",
            "DIFF_HUNK:DERIVED_FROM:CHANGED_FILE",
            "ERROR_SIGNAL:DERIVED_FROM:JOB_LOG_EXCERPT",
            "FAILING_TEST:DERIVED_FROM:JOB_LOG_EXCERPT",
            "JOB_LOG_EXCERPT:DERIVED_FROM:WORKFLOW_JOB",
            "WORKFLOW_JOB:DERIVED_FROM:WORKFLOW_RUN",
          ].sort(),
        );
      },
    );

    it(
      "is idempotent when the provenance edge already exists",
      () => {
        const input =
          baseResult();

        input.edges.push({
          fromDedupeKey:
            "changed-file",

          toDedupeKey:
            "workflow-run",

          relation:
            "DERIVED_FROM",

          metadata: {
            reason:
              "WORKFLOW_CHANGESET",
          },
        });

        input.summary.edgesProduced =
          6;

        const result =
          augmentEvidenceGraph(
            input,
          );

        expect(
          result.edges.filter(
            (graphEdge) =>
              graphEdge.fromDedupeKey ===
                "changed-file" &&
              graphEdge.toDedupeKey ===
                "workflow-run" &&
              graphEdge.relation ===
                "DERIVED_FROM",
          ),
        ).toHaveLength(1);

        expect(
          result.summary.edgesProduced,
        ).toBe(6);
      },
    );

    it(
      "fails closed when multiple workflow-run nodes exist",
      () => {
        const input =
          baseResult();

        input.items.push(
          evidence(
            "other-workflow-run",
            "WORKFLOW_RUN",
          ),
        );

        const result =
          augmentEvidenceGraph(
            input,
          );

        expect(
          result.edges.some(
            (graphEdge) =>
              graphEdge.fromDedupeKey ===
              "changed-file" &&
              graphEdge.toDedupeKey ===
              "workflow-run",
          ),
        ).toBe(false);

        expect(
          result.summary.edgesProduced,
        ).toBe(5);
      },
    );

    it(
      "does not create unsupported causal relationships",
      () => {
        const result =
          augmentEvidenceGraph(
            baseResult(),
          );

        expect(
          result.edges.some(
            (graphEdge) =>
              graphEdge.relation ===
                "RELATED_TO" ||
              graphEdge.relation ===
                "POINTS_TO_FILE",
          ),
        ).toBe(false);
      },
    );
  },
);