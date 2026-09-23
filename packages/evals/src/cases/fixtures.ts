import type {
  EvidenceCollectionResult,
  EvidenceDraft,
  EvidenceEdgeDraft,
  JsonObject,
} from "@incidentpilot/domain";

const DIGEST = "0".repeat(64);
const COLLECTED_AT = "2026-09-21T00:00:00.000Z";

function item(
  dedupeKey: string,
  kind: EvidenceDraft["kind"],
  content: string,
  options: {
    contentClass?: EvidenceDraft["contentClass"];
    metadata?: JsonObject;
  } = {},
): EvidenceDraft {
  const derived = ["ERROR_SIGNAL", "FAILING_TEST", "STACK_FRAME"].includes(
    kind,
  );

  return {
    dedupeKey,
    kind,
    sourceKind: derived ? "DERIVED" : "GITHUB_API",
    integrity: derived
      ? "DERIVED_FROM_AUTHENTICATED"
      : "PROVIDER_AUTHENTICATED",
    contentClass: options.contentClass ?? "STRUCTURED_METADATA",
    sensitivity: "POTENTIALLY_SENSITIVE",
    instructionTrust: "NEVER_INSTRUCTIONS",
    content,
    contentSha256: DIGEST,
    metadata: options.metadata ?? {},
    collectedAt: COLLECTED_AT,
  };
}

function edge(
  fromDedupeKey: string,
  toDedupeKey: string,
  relation: EvidenceEdgeDraft["relation"] = "DERIVED_FROM",
): EvidenceEdgeDraft {
  return {
    fromDedupeKey,
    toDedupeKey,
    relation,
    metadata: {},
  };
}

export interface DiagnosticFixtureOptions {
  message: string;
  path?: string;
  changedContent?: string;
  extraLogLines?: string[];
  injectionSignals?: string[];
  secondDiagnostic?: {
    message: string;
    path?: string;
  };
  partial?: boolean;
  truncated?: boolean;
}

export function diagnosticFixture(
  options: DiagnosticFixtureOptions,
): EvidenceCollectionResult {
  const path = options.path ?? "src/index.ts";
  const logLines = [options.message, ...(options.extraLogLines ?? [])];
  const log = logLines
    .map((line, index) => `${index + 1}: ${line}`)
    .join("\n");

  const items: EvidenceDraft[] = [
    item("run", "WORKFLOW_RUN", '{"conclusion":"failure"}'),
    item("job", "WORKFLOW_JOB", '{"name":"test"}'),
    item("log", "JOB_LOG_EXCERPT", log, {
      contentClass: "UNTRUSTED_TEXT",
      metadata: options.injectionSignals?.length
        ? { injectionSignals: options.injectionSignals }
        : {},
    }),
    item(
      "error",
      "ERROR_SIGNAL",
      JSON.stringify({
        message: options.message,
        path,
        parserVersion: 2,
        sourceLineStart: 1,
        sourceLineEnd: 1,
      }),
    ),
    item(
      "file",
      "CHANGED_FILE",
      JSON.stringify({ filename: path }),
    ),
    item(
      "diff",
      "DIFF_HUNK",
      options.changedContent ?? "@@ -1 +1 @@\n-old\n+new",
      { contentClass: "UNTRUSTED_TEXT" },
    ),
  ];

  const edges: EvidenceEdgeDraft[] = [
    edge("job", "run"),
    edge("log", "job"),
    edge("error", "log"),
    edge("file", "run"),
    edge("diff", "file"),
    edge("error", "file", "POINTS_TO_FILE"),
  ];

  if (options.secondDiagnostic) {
    const secondPath = options.secondDiagnostic.path ?? path;
    const secondLine = logLines.length + 1;
    const currentLog = items.find((entry) => entry.dedupeKey === "log");
    if (currentLog) {
      currentLog.content += `\n${secondLine}: ${options.secondDiagnostic.message}`;
    }

    items.push(
      item(
        "error-2",
        "ERROR_SIGNAL",
        JSON.stringify({
          message: options.secondDiagnostic.message,
          path: secondPath,
          parserVersion: 2,
          sourceLineStart: secondLine,
          sourceLineEnd: secondLine,
        }),
      ),
    );
    edges.push(edge("error-2", "log"));

    if (secondPath === path) {
      edges.push(edge("error-2", "file", "POINTS_TO_FILE"));
    }
  }

  return {
    items,
    edges,
    summary: {
      status: options.partial ? "PARTIAL" : "COMPLETED",
      requestsUsed: 4,
      downloadedBytes: log.length,
      itemsProduced: items.length,
      edgesProduced: edges.length,
      truncated: options.truncated ?? false,
      errorCodes: options.partial ? ["PROVIDER_PARTIAL"] : [],
      baseResolution: "HEAD_PARENT",
    },
  };
}

export function insufficientFixture(label: string): EvidenceCollectionResult {
  const items = [
    item("run", "WORKFLOW_RUN", '{"conclusion":"failure"}'),
    item("job", "WORKFLOW_JOB", JSON.stringify({ name: label })),
    item(
      "log",
      "JOB_LOG_EXCERPT",
      "1: Process exited without a retained diagnostic",
      { contentClass: "UNTRUSTED_TEXT" },
    ),
  ];
  const edges = [edge("job", "run"), edge("log", "job")];

  return {
    items,
    edges,
    summary: {
      status: "PARTIAL",
      requestsUsed: 2,
      downloadedBytes: 48,
      itemsProduced: items.length,
      edgesProduced: edges.length,
      truncated: true,
      errorCodes: ["DIAGNOSTIC_NOT_RETAINED"],
      baseResolution: "UNAVAILABLE",
    },
  };
}
