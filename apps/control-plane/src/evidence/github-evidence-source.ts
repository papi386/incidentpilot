import type {
  EvidenceCollectionResult,
  EvidenceDraft,
  EvidenceEdgeDraft,
  EvidenceKind,
  EvidenceSource,
  IncidentEvidenceContext,
  JsonObject
} from "@incidentpilot/domain";
import { GitHubApiClient, GitHubApiError, GitHubSecurityValidationError } from "../github/github-api";
import { isDiagnosticFailureConclusion } from "../github/conclusion-policy";
import { GitHubAppTokenBroker, GitHubAuthError, type GitHubReadPermission } from "../github/github-app-auth";
import { EVIDENCE_LIMITS } from "../security/resource-limits";
import { sha256Hex } from "../security/sha256";
import { extractFailureSignals } from "./failure-signals";
import { detectInjectionSignals } from "./injection-signals";
import { buildRelevantLogExcerpt } from "./log-excerpt";
import { redactSensitiveText } from "./redaction";

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

const LIMITS = EVIDENCE_LIMITS;

class RequestBudgetExceeded extends Error {
  constructor() {
    super("Evidence collection request budget exhausted");
    this.name = "RequestBudgetExceeded";
  }
}

class BudgetedFetch {
  requestsUsed = 0;
  private readonly baseFetch: FetchLike;

  constructor(fetchImpl?: FetchLike) {
    this.baseFetch = fetchImpl ?? ((input, init) => fetch(input, init));
  }

  readonly fetch: FetchLike = async (input, init) => {
    if (this.requestsUsed >= LIMITS.maxRequests) throw new RequestBudgetExceeded();
    this.requestsUsed += 1;
    return await this.baseFetch(input, init);
  };
}

interface WorkflowRunResponse {
  id?: number;
  name?: string;
  status?: string;
  conclusion?: string | null;
  event?: string;
  run_attempt?: number;
  head_sha?: string;
  head_branch?: string | null;
  created_at?: string;
  updated_at?: string;
  pull_requests?: Array<{
    base?: { sha?: string };
    head?: { sha?: string };
  }>;
}

interface WorkflowJobsResponse {
  total_count?: number;
  jobs?: Array<{
    id?: number;
    name?: string;
    status?: string;
    conclusion?: string | null;
    started_at?: string | null;
    completed_at?: string | null;
    steps?: Array<{
      number?: number;
      name?: string;
      status?: string;
      conclusion?: string | null;
    }>;
  }>;
}

interface CheckRunResponse {
  id?: number;
  name?: string;
  status?: string;
  conclusion?: string | null;
  head_sha?: string;
  started_at?: string | null;
  completed_at?: string | null;
  output?: {
    title?: string | null;
    summary?: string | null;
    text?: string | null;
  };
  pull_requests?: Array<{
    base?: { sha?: string };
    head?: { sha?: string };
  }>;
}

interface CommitResponse {
  sha?: string;
  parents?: Array<{ sha?: string }>;
}

interface CompareResponse {
  status?: string;
  ahead_by?: number;
  behind_by?: number;
  total_commits?: number;
  files?: Array<{
    sha?: string;
    filename?: string;
    status?: string;
    additions?: number;
    deletions?: number;
    changes?: number;
    previous_filename?: string;
    patch?: string;
  }>;
}

type CompareFile = NonNullable<CompareResponse["files"]>[number];

function splitRepository(fullName: string): { owner: string; repo: string } | null {
  const slash = fullName.indexOf("/");
  if (slash <= 0 || slash === fullName.length - 1) return null;
  return { owner: fullName.slice(0, slash), repo: fullName.slice(slash + 1) };
}

function apiPath(owner: string, repo: string, suffix: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${suffix}`;
}

function sourceUrl(path: string): string {
  return `https://api.github.com${path}`;
}

function safeErrorCode(error: unknown): string {
  if (error instanceof GitHubApiError) return `GITHUB_${error.code}`;
  if (error instanceof GitHubSecurityValidationError) return `SECURITY_${error.code}`;
  if (error instanceof GitHubAuthError) {
    return `GITHUB_AUTH_${error.code}${error.privateKeyFailure ? `_${error.privateKeyFailure}` : ""}`;
  }
  if (error instanceof RequestBudgetExceeded) return "REQUEST_BUDGET_EXHAUSTED";
  if (error instanceof DOMException && error.name === "AbortError") return "NETWORK_TIMEOUT";
  return "UNEXPECTED_COLLECTION_ERROR";
}


function isRetryableCriticalError(error: unknown): boolean {
  if (error instanceof RequestBudgetExceeded) return false;
  if (error instanceof GitHubSecurityValidationError) return false;
  if (error instanceof GitHubApiError) {
    if (error.code === "RATE_LIMITED" || error.code === "NETWORK_TIMEOUT" || error.code === "NETWORK_ERROR") return true;
    return /^(?:HTTP|LOG_DOWNLOAD|LOG_REDIRECT)_5\d\d$/u.test(error.code);
  }
  if (error instanceof GitHubAuthError) {
    return error.code === "TOKEN_REQUEST_TIMEOUT"
      || error.code === "TOKEN_REQUEST_NETWORK_ERROR"
      || error.code === "TOKEN_RATE_LIMITED"
      || error.status === 429
      || (error.code === "TOKEN_REQUEST_FAILED" && error.status !== undefined && error.status >= 500);
  }
  if (error instanceof DOMException && error.name === "AbortError") return true;
  return false;
}

function jsonContent(value: JsonObject): string {
  return JSON.stringify(value);
}

function asJsonObject(value: Record<string, unknown>): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function normalizedPath(value: string): string {
  return value.replace(/\\/gu, "/").replace(/^\.\//u, "");
}

function pathMatches(framePath: string, changedPath: string): boolean {
  const frame = normalizedPath(framePath);
  const changed = normalizedPath(changedPath);
  return frame === changed || frame.endsWith(`/${changed}`) || changed.endsWith(`/${frame}`);
}

function boundedPatch(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  const marker = "\n...[middle of patch omitted]...\n";
  const available = maximum - marker.length;
  const head = Math.ceil(available / 2);
  const tail = Math.floor(available / 2);
  return `${value.slice(0, head)}${marker}${value.slice(value.length - tail)}`;
}

export class GitHubEvidenceSource implements EvidenceSource {
  constructor(
    private readonly appClientId: string,
    private readonly privateKeyPkcs8B64: string,
    private readonly fetchImpl?: FetchLike
  ) {}

  async collect(context: IncidentEvidenceContext): Promise<EvidenceCollectionResult> {
    const budget = new BudgetedFetch(this.fetchImpl);
    const items: EvidenceDraft[] = [];
    const edges: EvidenceEdgeDraft[] = [];
    const errorCodes = new Set<string>();
    let downloadedBytes = 0;
    let truncated = false;
    let baseResolution: EvidenceCollectionResult["summary"]["baseResolution"] = "UNAVAILABLE";
    const collectedAt = new Date().toISOString();

    const addItem = async (
      draft: Omit<EvidenceDraft, "contentSha256" | "collectedAt" | "instructionTrust">
    ): Promise<boolean> => {
      if (items.length >= LIMITS.maxItems) {
        truncated = true;
        return false;
      }
      items.push({
        ...draft,
        instructionTrust: "NEVER_INSTRUCTIONS",
        contentSha256: await sha256Hex(draft.content),
        collectedAt
      });
      return true;
    };

    const addEdge = (edge: EvidenceEdgeDraft): void => {
      if (edges.length >= LIMITS.maxEdges) {
        truncated = true;
        errorCodes.add("EVIDENCE_EDGE_BUDGET_EXHAUSTED");
        return;
      }
      if (items.some((item) => item.dedupeKey === edge.fromDedupeKey)
          && items.some((item) => item.dedupeKey === edge.toDedupeKey)) {
        edges.push(edge);
      }
    };

    const finalize = (status: "COMPLETED" | "PARTIAL" | "FAILED"): EvidenceCollectionResult => ({
      items,
      edges,
      summary: {
        status,
        requestsUsed: budget.requestsUsed,
        downloadedBytes,
        itemsProduced: items.length,
        edgesProduced: edges.length,
        truncated,
        errorCodes: [...errorCodes].sort(),
        baseResolution
      }
    });

    if (!context.installationExternalId) {
      errorCodes.add("MISSING_INSTALLATION_ID");
      return finalize("FAILED");
    }

    const repoParts = splitRepository(context.repositoryFullName);
    if (!repoParts) {
      errorCodes.add("INVALID_REPOSITORY_FULL_NAME");
      return finalize("FAILED");
    }

    const permissions: GitHubReadPermission[] = context.triggerType === "GITHUB_WORKFLOW_RUN"
      ? ["actions", "contents"]
      : ["checks", "contents"];

    const broker = new GitHubAppTokenBroker(
      this.appClientId,
      this.privateKeyPkcs8B64,
      budget.fetch
    );
    const tokenRequest = {
      installationExternalId: context.installationExternalId,
      repositoryExternalId: context.repositoryExternalId,
      permissions
    } as const;

    let token: string;
    try {
      token = (await broker.createInstallationToken(tokenRequest)).token;
    } catch (error) {
      if (isRetryableCriticalError(error)) throw error;
      errorCodes.add(safeErrorCode(error));
      return finalize("FAILED");
    }

    const api = new GitHubApiClient(
      token,
      budget.fetch,
      8_000,
      async () => (await broker.createInstallationToken(tokenRequest)).token
    );
    const { owner, repo } = repoParts;
    let headSha = context.headSha;
    let baseSha = context.baseSha;
    if (baseSha) baseResolution = "INCIDENT";

    const signalPaths: Array<{ dedupeKey: string; path: string }> = [];
    const changedFiles: Array<{ dedupeKey: string; path: string }> = [];

    try {
      if (context.triggerType === "GITHUB_WORKFLOW_RUN") {
        const runPath = apiPath(owner, repo, `/actions/runs/${encodeURIComponent(context.triggerExternalId)}`);
        const run = await api.getJson<WorkflowRunResponse>(runPath);
        headSha = run.head_sha ?? headSha;

        const pullRequestBase = run.pull_requests?.[0]?.base?.sha;
        if (!baseSha && pullRequestBase) {
          baseSha = pullRequestBase;
          baseResolution = "WORKFLOW_PULL_REQUEST";
        }

        const runKey = `workflow-run:${context.triggerExternalId}`;
        const runMetadata = asJsonObject({
          id: run.id ?? context.triggerExternalId,
          name: run.name ?? null,
          status: run.status ?? null,
          conclusion: run.conclusion ?? null,
          event: run.event ?? null,
          runAttempt: run.run_attempt ?? null,
          headSha: headSha ?? null,
          headBranch: run.head_branch ?? null,
          createdAt: run.created_at ?? null,
          updatedAt: run.updated_at ?? null
        });
        const sanitizedRun = redactSensitiveText(jsonContent(runMetadata));
        await addItem({
          dedupeKey: runKey,
          kind: "WORKFLOW_RUN",
          sourceKind: "GITHUB_API",
          sourceExternalId: String(run.id ?? context.triggerExternalId),
          sourceUrl: sourceUrl(runPath),
          integrity: "PROVIDER_AUTHENTICATED",
          contentClass: "STRUCTURED_METADATA",
          sensitivity: "NORMAL",
          content: sanitizedRun.text,
          metadata: {
            redactionCount: sanitizedRun.count,
            redactionKinds: sanitizedRun.kinds
          }
        });

        try {
          const jobsPath = apiPath(owner, repo, `/actions/runs/${encodeURIComponent(context.triggerExternalId)}/jobs?filter=latest&per_page=100`);
          const jobsResponse = await api.getJson<WorkflowJobsResponse>(jobsPath);
          const returnedJobs = jobsResponse.jobs ?? [];
          if ((jobsResponse.total_count ?? returnedJobs.length) > returnedJobs.length) {
            truncated = true;
            errorCodes.add("JOB_LIST_TRUNCATED");
          }
          const failedJobs = returnedJobs.filter((job) => isDiagnosticFailureConclusion(job.conclusion));

          for (const job of failedJobs.slice(0, LIMITS.maxFailedJobs)) {
            if (job.id === undefined) continue;
            const jobKey = `workflow-job:${job.id}`;
            const failedSteps = (job.steps ?? [])
              .filter((step) => isDiagnosticFailureConclusion(step.conclusion))
              .slice(0, 10)
              .map((step) => ({
                number: step.number ?? null,
                name: step.name ?? null,
                status: step.status ?? null,
                conclusion: step.conclusion ?? null
              }));
            const jobMetadata = asJsonObject({
              id: job.id,
              name: job.name ?? null,
              status: job.status ?? null,
              conclusion: job.conclusion ?? null,
              startedAt: job.started_at ?? null,
              completedAt: job.completed_at ?? null,
              failedSteps
            });
            const sanitizedJob = redactSensitiveText(jsonContent(jobMetadata));
            const addedJob = await addItem({
              dedupeKey: jobKey,
              kind: "WORKFLOW_JOB",
              sourceKind: "GITHUB_API",
              sourceExternalId: String(job.id),
              sourceUrl: sourceUrl(apiPath(owner, repo, `/actions/jobs/${job.id}`)),
              integrity: "PROVIDER_AUTHENTICATED",
              contentClass: "STRUCTURED_METADATA",
              sensitivity: "NORMAL",
              content: sanitizedJob.text,
              metadata: {
                redactionCount: sanitizedJob.count,
                redactionKinds: sanitizedJob.kinds
              }
            });
            if (addedJob) {
              addEdge({ fromDedupeKey: jobKey, toDedupeKey: runKey, relation: "DERIVED_FROM", metadata: {} });
            }

            if (downloadedBytes >= LIMITS.maxDownloadedLogBytes) {
              truncated = true;
              errorCodes.add("LOG_BYTE_BUDGET_EXHAUSTED");
              break;
            }

            try {
              const perJobLimit = Math.min(
                LIMITS.maxLogBytesPerJob,
                LIMITS.maxDownloadedLogBytes - downloadedBytes
              );
              const logPath = apiPath(owner, repo, `/actions/jobs/${job.id}/logs`);
              const log = await api.getJobLog(logPath, perJobLimit);
              downloadedBytes += log.bytesRead;
              truncated ||= log.truncated;

              const redacted = redactSensitiveText(log.text);
              const excerpt = buildRelevantLogExcerpt(redacted.text);
              truncated ||= excerpt.truncated;
              const injectionSignals = detectInjectionSignals(excerpt.excerpt);
              const logKey = `job-log-excerpt:${job.id}`;

              const addedLog = await addItem({
                dedupeKey: logKey,
                kind: "JOB_LOG_EXCERPT",
                sourceKind: "GITHUB_REDIRECT",
                sourceExternalId: String(job.id),
                // Persist the stable GitHub API URL, never the temporary signed redirect URL.
                sourceUrl: sourceUrl(logPath),
                integrity: "PROVIDER_AUTHENTICATED",
                contentClass: "UNTRUSTED_TEXT",
                sensitivity: "POTENTIALLY_SENSITIVE",
                content: excerpt.excerpt,
                metadata: {
                  sourceBytesRead: log.bytesRead,
                  sourceTruncated: log.truncated,
                  selectedLineCount: excerpt.selectedLineCount,
                  redactionCount: redacted.count,
                  redactionKinds: redacted.kinds,
                  injectionSignals
                }
              });
              if (addedLog && addedJob) {
                addEdge({ fromDedupeKey: logKey, toDedupeKey: jobKey, relation: "DERIVED_FROM", metadata: {} });
              }

              for (const signal of extractFailureSignals(excerpt.excerpt)) {
                const signalKey = `${signal.kind.toLowerCase()}:${job.id}:${await sha256Hex(signal.key)}`;
                const signalContent = jsonContent(asJsonObject(signal.value));
                const addedSignal = await addItem({
                  dedupeKey: signalKey,
                  kind: signal.kind as EvidenceKind,
                  sourceKind: "DERIVED",
                  sourceExternalId: String(job.id),
                  integrity: "DERIVED_FROM_AUTHENTICATED",
                  contentClass: "STRUCTURED_METADATA",
                  sensitivity: "POTENTIALLY_SENSITIVE",
                  content: signalContent,
                  metadata: { derivedBy: "deterministic-failure-signal-parser-v1" }
                });
                if (addedSignal && addedLog) {
                  addEdge({
                    fromDedupeKey: signalKey,
                    toDedupeKey: logKey,
                    relation: "DERIVED_FROM",
                    metadata: {}
                  });
                }
                if (addedSignal && typeof signal.value.path === "string") {
                  signalPaths.push({ dedupeKey: signalKey, path: signal.value.path });
                }
              }
            } catch (error) {
              if (isRetryableCriticalError(error)) throw error;
              errorCodes.add(safeErrorCode(error));
            }
          }

          if (failedJobs.length > LIMITS.maxFailedJobs) truncated = true;
        } catch (error) {
          if (isRetryableCriticalError(error)) throw error;
          errorCodes.add(safeErrorCode(error));
        }
      } else {
        const checkPath = apiPath(owner, repo, `/check-runs/${encodeURIComponent(context.triggerExternalId)}`);
        const check = await api.getJson<CheckRunResponse>(checkPath);
        headSha = check.head_sha ?? headSha;
        const pullRequestBase = check.pull_requests?.[0]?.base?.sha;
        if (!baseSha && pullRequestBase) {
          baseSha = pullRequestBase;
          baseResolution = "WORKFLOW_PULL_REQUEST";
        }
        const checkKey = `check-run:${context.triggerExternalId}`;
        const checkMetadata = asJsonObject({
          id: check.id ?? context.triggerExternalId,
          name: check.name ?? null,
          status: check.status ?? null,
          conclusion: check.conclusion ?? null,
          headSha: headSha ?? null,
          startedAt: check.started_at ?? null,
          completedAt: check.completed_at ?? null
        });
        const sanitizedCheck = redactSensitiveText(jsonContent(checkMetadata));
        await addItem({
          dedupeKey: checkKey,
          kind: "CHECK_RUN",
          sourceKind: "GITHUB_API",
          sourceExternalId: String(check.id ?? context.triggerExternalId),
          sourceUrl: sourceUrl(checkPath),
          integrity: "PROVIDER_AUTHENTICATED",
          contentClass: "STRUCTURED_METADATA",
          sensitivity: "NORMAL",
          content: sanitizedCheck.text,
          metadata: {
            redactionCount: sanitizedCheck.count,
            redactionKinds: sanitizedCheck.kinds
          }
        });

        const rawOutput = [check.output?.title, check.output?.summary, check.output?.text]
          .filter((value): value is string => typeof value === "string" && value.length > 0)
          .join("\n");
        if (rawOutput) {
          const redacted = redactSensitiveText(rawOutput);
          const output = redacted.text.slice(0, LIMITS.maxCheckOutputChars);
          const outputKey = `check-output:${context.triggerExternalId}`;
          const added = await addItem({
            dedupeKey: outputKey,
            kind: "CHECK_OUTPUT",
            sourceKind: "GITHUB_API",
            sourceExternalId: String(check.id ?? context.triggerExternalId),
            sourceUrl: sourceUrl(checkPath),
            integrity: "PROVIDER_AUTHENTICATED",
            contentClass: "UNTRUSTED_TEXT",
            sensitivity: "POTENTIALLY_SENSITIVE",
            content: output,
            metadata: {
              sourceTruncated: redacted.text.length > LIMITS.maxCheckOutputChars,
              redactionCount: redacted.count,
              redactionKinds: redacted.kinds,
              injectionSignals: detectInjectionSignals(output)
            }
          });
          if (added) addEdge({ fromDedupeKey: outputKey, toDedupeKey: checkKey, relation: "DERIVED_FROM", metadata: {} });
          if (redacted.text.length > LIMITS.maxCheckOutputChars) truncated = true;
        }
      }
    } catch (error) {
      if (isRetryableCriticalError(error)) throw error;
      errorCodes.add(safeErrorCode(error));
      return finalize(items.length > 0 ? "PARTIAL" : "FAILED");
    }

    if (!headSha) {
      errorCodes.add("HEAD_SHA_UNAVAILABLE");
    } else {
      if (!baseSha) {
        try {
          const commitPath = apiPath(owner, repo, `/commits/${encodeURIComponent(headSha)}`);
          const commit = await api.getJson<CommitResponse>(commitPath);
          const parent = commit.parents?.[0]?.sha;
          if (parent) {
            baseSha = parent;
            baseResolution = "HEAD_PARENT";
          }
        } catch (error) {
          if (isRetryableCriticalError(error)) throw error;
          errorCodes.add(safeErrorCode(error));
        }
      }

      if (baseSha && baseSha !== headSha) {
        try {
          const comparePath = apiPath(
            owner,
            repo,
            `/compare/${encodeURIComponent(baseSha)}...${encodeURIComponent(headSha)}`
          );
          const compare = await api.getJson<CompareResponse>(comparePath);
          const files = (compare.files ?? [])
            .map((file, index) => ({ file, index }))
            .sort((left, right) => {
              const relevant = (candidate: CompareFile) =>
                signalPaths.some((signal) =>
                  (candidate.filename && pathMatches(signal.path, candidate.filename)) ||
                  (candidate.previous_filename && pathMatches(signal.path, candidate.previous_filename))
                );
              const difference = Number(relevant(right.file)) - Number(relevant(left.file));
              return difference === 0 ? left.index - right.index : difference;
            })
            .slice(0, LIMITS.maxChangedFiles)
            .map((entry) => entry.file);
          let patchItems = 0;

          for (const file of files) {
            if (!file.filename) continue;
            const filename = normalizedPath(file.filename);
            const fileKey = `changed-file:${headSha}:${filename}`;
            const fileMetadata = asJsonObject({
              filename,
              previousFilename: file.previous_filename ?? null,
              status: file.status ?? null,
              additions: file.additions ?? null,
              deletions: file.deletions ?? null,
              changes: file.changes ?? null,
              blobSha: file.sha ?? null,
              compareStatus: compare.status ?? null,
              aheadBy: compare.ahead_by ?? null,
              behindBy: compare.behind_by ?? null,
              totalCommits: compare.total_commits ?? null
            });
            const sanitizedFile = redactSensitiveText(jsonContent(fileMetadata));
            const addedFile = await addItem({
              dedupeKey: fileKey,
              kind: "CHANGED_FILE",
              sourceKind: "GITHUB_API",
              ...(file.sha ? { sourceExternalId: file.sha } : {}),
              sourceUrl: sourceUrl(comparePath),
              integrity: "PROVIDER_AUTHENTICATED",
              contentClass: "STRUCTURED_METADATA",
              sensitivity: "NORMAL",
              content: sanitizedFile.text,
              metadata: {
                redactionCount: sanitizedFile.count,
                redactionKinds: sanitizedFile.kinds
              }
            });
            if (addedFile) changedFiles.push({ dedupeKey: fileKey, path: filename });

            if (file.patch && patchItems < LIMITS.maxPatchItems) {
              const redactedPatch = redactSensitiveText(file.patch);
              const patch = boundedPatch(redactedPatch.text, LIMITS.maxPatchChars);
              const patchKey = `diff-hunk:${headSha}:${filename}`;
              const addedPatch = await addItem({
                dedupeKey: patchKey,
                kind: "DIFF_HUNK",
                sourceKind: "GITHUB_API",
                ...(file.sha ? { sourceExternalId: file.sha } : {}),
                sourceUrl: sourceUrl(comparePath),
                integrity: "PROVIDER_AUTHENTICATED",
                contentClass: "UNTRUSTED_TEXT",
                sensitivity: "POTENTIALLY_SENSITIVE",
                content: patch,
                metadata: {
                  filename,
                  sourceTruncated: redactedPatch.text.length > LIMITS.maxPatchChars,
                  redactionCount: redactedPatch.count,
                  redactionKinds: redactedPatch.kinds,
                  injectionSignals: detectInjectionSignals(patch)
                }
              });
              if (addedPatch && addedFile) {
                addEdge({ fromDedupeKey: patchKey, toDedupeKey: fileKey, relation: "DERIVED_FROM", metadata: {} });
              }
              if (redactedPatch.text.length > LIMITS.maxPatchChars) truncated = true;
              patchItems += 1;
            }
          }

          if ((compare.files?.length ?? 0) > LIMITS.maxChangedFiles) truncated = true;
        } catch (error) {
          if (isRetryableCriticalError(error)) throw error;
          errorCodes.add(safeErrorCode(error));
        }
      } else if (!baseSha) {
        errorCodes.add("BASE_SHA_UNAVAILABLE");
      }
    }

    for (const signal of signalPaths) {
      const match = changedFiles.find((file) => pathMatches(signal.path, file.path));
      if (match) {
        addEdge({
          fromDedupeKey: signal.dedupeKey,
          toDedupeKey: match.dedupeKey,
          relation: "POINTS_TO_FILE",
          metadata: { path: signal.path }
        });
      }
    }

    const status = items.length === 0
      ? "FAILED"
      : errorCodes.size > 0 || truncated
        ? "PARTIAL"
        : "COMPLETED";
    return finalize(status);
  }
}
