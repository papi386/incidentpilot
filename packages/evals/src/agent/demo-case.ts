import type {
  EvidenceCollectionResult,
  EvidenceDraft,
  EvidenceEdgeDraft,
  JsonObject,
} from "@incidentpilot/domain";

const DIGEST = "0".repeat(64);
const COLLECTED_AT = "2026-09-22T00:00:00.000Z";

function item(
  dedupeKey: string,
  kind: EvidenceDraft["kind"],
  content: string,
  metadata: JsonObject = {},
): EvidenceDraft {
  const derived = ["ERROR_SIGNAL", "FAILING_TEST", "STACK_FRAME"].includes(kind);
  return {
    dedupeKey,
    kind,
    sourceKind: derived ? "DERIVED" : "GITHUB_API",
    integrity: derived ? "DERIVED_FROM_AUTHENTICATED" : "PROVIDER_AUTHENTICATED",
    contentClass: ["JOB_LOG_EXCERPT", "DIFF_HUNK"].includes(kind)
      ? "UNTRUSTED_TEXT"
      : "STRUCTURED_METADATA",
    sensitivity: "POTENTIALLY_SENSITIVE",
    instructionTrust: "NEVER_INSTRUCTIONS",
    content,
    contentSha256: DIGEST,
    metadata,
    collectedAt: COLLECTED_AT,
  };
}

function edge(
  fromDedupeKey: string,
  toDedupeKey: string,
  relation: EvidenceEdgeDraft["relation"] = "DERIVED_FROM",
): EvidenceEdgeDraft {
  return { fromDedupeKey, toDedupeKey, relation, metadata: {} };
}

export interface DemoArtifacts {
  logs: Record<string, { evidenceId: string; text: string; label: string }>;
  diffs: Record<string, { evidenceId: string; text: string }>;
  baselines: Record<string, { evidenceId: string; text: string }>;
}

export interface AgentDemoCase {
  title: string;
  collection: EvidenceCollectionResult;
  artifacts: DemoArtifacts;
}

export function buildAgentDemoCase(): AgentDemoCase {
  const rawLines = Array.from(
    { length: 130 },
    (_, index) => `${String(index + 1).padStart(3, "0")} routine test output`,
  );
  rawLines[115] = "FAIL test/api.test.ts > POST /widgets returns the documented status";
  rawLines[116] = "expected status: 200";
  rawLines[117] = "received status: 201";
  rawLines[118] = "AssertionError: expected 201 to equal 200";
  rawLines[119] = "    at test/api.test.ts:42:31";
  rawLines[120] = "Test Files  1 failed | 18 passed";

  const collection: EvidenceCollectionResult = {
    items: [
      item("run", "WORKFLOW_RUN", JSON.stringify({
        conclusion: "failure",
        headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      })),
      item("job", "WORKFLOW_JOB", JSON.stringify({
        name: "test-node-22",
        conclusion: "failure",
        failedSteps: [{ number: 4, name: "Run unit tests", conclusion: "failure" }],
      })),
      item(
        "log",
        "JOB_LOG_EXCERPT",
        [
          "116: FAIL test/api.test.ts > POST /widgets returns the documented status",
          "117: expected status: 200",
          "118: received status: 201",
          "119: AssertionError: expected 201 to equal 200",
          "120:     at test/api.test.ts:42:31",
          "121: Test Files  1 failed | 18 passed",
        ].join("\n"),
        { sourceTruncated: true, selectedLineCount: 6 },
      ),
      item("test-failure", "FAILING_TEST", JSON.stringify({
        framework: "vitest",
        test: "POST /widgets returns the documented status",
        path: "test/api.test.ts",
        parserVersion: 2,
        sourceLineStart: 116,
        sourceLineEnd: 116,
      })),
      item("assertion", "ERROR_SIGNAL", JSON.stringify({
        exception: "AssertionError",
        message: "expected 201 to equal 200",
        parserVersion: 2,
        sourceLineStart: 119,
        sourceLineEnd: 119,
      })),
      item("frame", "STACK_FRAME", JSON.stringify({
        language: "javascript-typescript",
        path: "test/api.test.ts",
        line: 42,
        column: 31,
        parserVersion: 2,
        sourceLineStart: 120,
        sourceLineEnd: 120,
      })),
      item("file-api", "CHANGED_FILE", JSON.stringify({
        filename: "src/api.ts",
        status: "modified",
      })),
      item("file-test", "CHANGED_FILE", JSON.stringify({
        filename: "test/api.test.ts",
        status: "modified",
      })),
      item(
        "diff-api",
        "DIFF_HUNK",
        "@@ -8,3 +8,3 @@\n-  return json(body, 200);\n+  return json(body, 201);",
        { filename: "src/api.ts", sourceTruncated: false },
      ),
      item(
        "diff-test",
        "DIFF_HUNK",
        "@@ -40,3 +40,3 @@\n-  expect(response.status).toBe(200);\n+  expect(response.status).toBe(200);",
        { filename: "test/api.test.ts", sourceTruncated: false },
      ),
    ],
    edges: [
      edge("job", "run"),
      edge("log", "job"),
      edge("test-failure", "log"),
      edge("assertion", "log"),
      edge("frame", "log"),
      edge("file-api", "run"),
      edge("file-test", "run"),
      edge("diff-api", "file-api"),
      edge("diff-test", "file-test"),
      edge("test-failure", "file-test", "POINTS_TO_FILE"),
      edge("frame", "file-test", "POINTS_TO_FILE"),
    ],
    summary: {
      status: "PARTIAL",
      requestsUsed: 6,
      downloadedBytes: rawLines.join("\n").length,
      itemsProduced: 10,
      edgesProduced: 11,
      truncated: true,
      errorCodes: [],
      baseResolution: "WORKFLOW_PULL_REQUEST",
    },
  };

  return {
    title: "API status-code regression with a failing unit assertion",
    collection,
    artifacts: {
      logs: {
        "job-log-501": {
          evidenceId: "log",
          label: "Full log for failed job test-node-22",
          text: rawLines.join("\n"),
        },
      },
      diffs: {
        "src/api.ts": {
          evidenceId: "diff-api",
          text: "@@ -6,7 +6,7 @@ export async function createWidget(request) {\n   const body = await persistWidget(request);\n-  return json(body, 200);\n+  return json(body, 201);\n }",
        },
        "test/api.test.ts": {
          evidenceId: "diff-test",
          text: "@@ -40,3 +40,3 @@\n   const response = await createWidget(validRequest);\n   expect(response.status).toBe(200);",
        },
      },
      baselines: {
        "src/api.ts": {
          evidenceId: "file-api",
          text: "Last successful run at the base SHA returned HTTP 200 for the same test and source path.",
        },
      },
    },
  };
}
