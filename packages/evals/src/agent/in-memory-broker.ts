import type {
  EvidenceArtifactDescriptor,
  EvidenceCollectionResult,
  EvidenceToolDescriptor,
  EvidenceToolRequest,
  EvidenceToolResponse,
  JsonObject,
  ReadOnlyEvidenceBroker,
} from "@incidentpilot/domain";
import { EvidenceToolPolicyError } from "@incidentpilot/domain";
import type { DemoArtifacts } from "./demo-case";

const TOOLS: readonly EvidenceToolDescriptor[] = [
  { name: "SEARCH_EVIDENCE", description: "Literal, case-insensitive search across retained evidence and full log artifacts." },
  { name: "READ_LOG_RANGE", description: "Read a bounded original line range from a named log artifact." },
  { name: "FOLLOW_PROVENANCE", description: "Inspect direct incoming and outgoing Evidence Graph relationships for an evidence id." },
  { name: "READ_DIFF", description: "Read the bounded diff for an exact repository-relative path." },
  { name: "COMPARE_BASELINE", description: "Read a deterministic comparison with the last known successful baseline for an exact path." },
] as const;

function safeRepositoryPath(value: string): boolean {
  return value.length <= 240 &&
    !value.startsWith("/") &&
    !/^[A-Za-z]:[\\/]/u.test(value) &&
    !value.replace(/\\/gu, "/").split("/").includes("..");
}

function bounded(content: string, maximum = 12_000): {
  content: string;
  truncated: boolean;
} {
  return content.length <= maximum
    ? { content, truncated: false }
    : { content: content.slice(0, maximum), truncated: true };
}

export class InMemoryEvidenceBroker implements ReadOnlyEvidenceBroker {
  constructor(
    private readonly collection: EvidenceCollectionResult,
    private readonly artifacts: DemoArtifacts,
  ) {}

  describeTools(): readonly EvidenceToolDescriptor[] {
    return TOOLS;
  }

  describeArtifacts(): readonly EvidenceArtifactDescriptor[] {
    return [
      ...Object.entries(this.artifacts.logs).map(([id, log]) => ({
        id,
        acceptedTargets: [id],
        kind: "LOG" as const,
        label: log.label,
        lineCount: log.text.replace(/\r\n?/gu, "\n").split("\n").length,
      })),
      ...Object.keys(this.artifacts.diffs).map((path) => ({
        id: path,
        acceptedTargets: [path, this.artifacts.diffs[path]!.evidenceId],
        kind: "DIFF" as const,
        label: `Changed diff for ${path}`,
        lineCount: this.artifacts.diffs[path]!.text.split("\n").length,
      })),
      ...Object.keys(this.artifacts.baselines).map((path) => ({
        id: path,
        acceptedTargets: [path, this.artifacts.baselines[path]!.evidenceId],
        kind: "BASELINE" as const,
        label: `Last successful baseline for ${path}`,
        lineCount: null,
      })),
    ];
  }

  async execute(request: EvidenceToolRequest): Promise<EvidenceToolResponse> {
    if (request.tool === "SEARCH_EVIDENCE") {
      if (!request.query) throw new EvidenceToolPolicyError("QUERY_REQUIRED");
      const query = request.query.toLowerCase();
      const matches: string[] = [];
      const sources = new Set<string>();
      for (const item of this.collection.items) {
        if (item.content.toLowerCase().includes(query)) {
          matches.push(`${item.dedupeKey} (${item.kind}): ${item.content.slice(0, 800)}`);
          sources.add(item.dedupeKey);
        }
      }
      for (const [id, log] of Object.entries(this.artifacts.logs)) {
        const lines = log.text.split(/\r\n?|\n/gu);
        lines.forEach((line, index) => {
          if (matches.length < 20 && line.toLowerCase().includes(query)) {
            matches.push(`${id}:${index + 1}: ${line}`);
            sources.add(log.evidenceId);
          }
        });
      }
      const result = bounded(matches.length > 0 ? matches.join("\n") : "NO_MATCHES");
      return {
        ...result,
        sourceEvidenceIds: [...sources],
        metadata: { matchCount: matches.length },
      };
    }

    if (request.tool === "READ_LOG_RANGE") {
      if (!request.target || request.startLine === null || request.endLine === null) {
        throw new EvidenceToolPolicyError("LOG_RANGE_REQUIRED");
      }
      const log = this.artifacts.logs[request.target];
      if (!log) throw new EvidenceToolPolicyError("UNKNOWN_LOG_ARTIFACT");
      if (request.endLine - request.startLine > 199) {
        throw new EvidenceToolPolicyError("LOG_RANGE_LIMIT_EXCEEDED");
      }
      const lines = log.text.replace(/\r\n?/gu, "\n").split("\n");
      const selected = lines.slice(request.startLine - 1, request.endLine)
        .map((line, index) => `${request.startLine! + index}: ${line}`)
        .join("\n");
      const result = bounded(selected);
      return {
        ...result,
        sourceEvidenceIds: [log.evidenceId],
        metadata: {
          artifactId: request.target,
          startLine: request.startLine,
          endLine: Math.min(request.endLine, lines.length),
        },
      };
    }

    if (request.tool === "FOLLOW_PROVENANCE") {
      if (!request.target) throw new EvidenceToolPolicyError("TARGET_REQUIRED");
      const source = this.collection.items.find((item) => item.dedupeKey === request.target);
      if (!source) throw new EvidenceToolPolicyError("UNKNOWN_EVIDENCE_ID");
      const related = this.collection.edges.filter((edge) =>
        edge.fromDedupeKey === request.target || edge.toDedupeKey === request.target
      );
      const content = related.length === 0
        ? "NO_DIRECT_RELATIONSHIPS"
        : related.map((edge) =>
          `${edge.fromDedupeKey} -[${edge.relation}]-> ${edge.toDedupeKey}`
        ).join("\n");
      const ids = new Set<string>([request.target]);
      related.forEach((edge) => {
        ids.add(edge.fromDedupeKey);
        ids.add(edge.toDedupeKey);
      });
      return {
        content,
        sourceEvidenceIds: [...ids],
        truncated: false,
        metadata: { relationshipCount: related.length },
      };
    }

    if (request.tool === "READ_DIFF") {
      if (!request.target || !safeRepositoryPath(request.target)) {
        throw new EvidenceToolPolicyError("UNSAFE_REPOSITORY_PATH");
      }
      const path = Object.keys(this.artifacts.diffs).find((candidate) =>
        candidate === request.target ||
        this.artifacts.diffs[candidate]!.evidenceId === request.target
      );
      if (!path) throw new EvidenceToolPolicyError("UNKNOWN_DIFF_ARTIFACT");
      if (!safeRepositoryPath(path)) throw new EvidenceToolPolicyError("UNSAFE_REPOSITORY_PATH");
      const diff = this.artifacts.diffs[path];
      if (!diff) throw new EvidenceToolPolicyError("UNKNOWN_DIFF_ARTIFACT");
      const result = bounded(diff.text);
      return {
        ...result,
        sourceEvidenceIds: [diff.evidenceId],
        metadata: { path, requestedTarget: request.target },
      };
    }

    if (!request.target || !safeRepositoryPath(request.target)) {
      throw new EvidenceToolPolicyError("UNSAFE_REPOSITORY_PATH");
    }
    const path = Object.keys(this.artifacts.baselines).find((candidate) =>
      candidate === request.target ||
      this.artifacts.baselines[candidate]!.evidenceId === request.target
    );
    if (!path) throw new EvidenceToolPolicyError("UNKNOWN_BASELINE_ARTIFACT");
    if (!safeRepositoryPath(path)) throw new EvidenceToolPolicyError("UNSAFE_REPOSITORY_PATH");
    const baseline = this.artifacts.baselines[path];
    if (!baseline) throw new EvidenceToolPolicyError("UNKNOWN_BASELINE_ARTIFACT");
    const result = bounded(baseline.text);
    return {
      ...result,
      sourceEvidenceIds: [baseline.evidenceId],
      truncated: false,
      metadata: {
        path,
        requestedTarget: request.target,
        comparison: "LAST_SUCCESSFUL_RUN",
      } as JsonObject,
    };
  }
}
