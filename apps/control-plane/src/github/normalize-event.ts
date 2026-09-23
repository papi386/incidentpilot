import type { IncidentTrigger } from "@incidentpilot/domain";
import { isIncidentConclusion } from "./conclusion-policy";

interface RepositoryShape {
  id?: number;
  full_name?: string;
}

interface InstallationShape {
  id?: number;
}

function repositoryFields(payload: Record<string, unknown>) {
  const repository = (payload.repository ?? {}) as RepositoryShape;
  const installation = (payload.installation ?? {}) as InstallationShape;
  if (!repository.id || !repository.full_name) return null;

  return {
    repositoryExternalId: String(repository.id),
    repositoryFullName: repository.full_name,
    ...(installation.id !== undefined
      ? { installationExternalId: String(installation.id) }
      : {})
  };
}


function pullRequestBaseSha(record: Record<string, unknown>): string | undefined {
  const pullRequests = record.pull_requests;
  if (!Array.isArray(pullRequests) || pullRequests.length === 0) return undefined;
  const first = pullRequests[0];
  if (!first || typeof first !== "object" || Array.isArray(first)) return undefined;
  const base = (first as Record<string, unknown>).base;
  if (!base || typeof base !== "object" || Array.isArray(base)) return undefined;
  const sha = (base as Record<string, unknown>).sha;
  return typeof sha === "string" && sha.length > 0 ? sha : undefined;
}

export function normalizeGitHubEvent(
  eventName: string,
  deliveryId: string,
  payload: Record<string, unknown>
): IncidentTrigger | null {
  const repo = repositoryFields(payload);
  if (!repo) return null;

  if (eventName === "workflow_run" && payload.action === "completed") {
    const run = (payload.workflow_run ?? {}) as Record<string, unknown>;
    const conclusion = typeof run.conclusion === "string" ? run.conclusion : null;
    if (!isIncidentConclusion(conclusion)) return null;
    const id = run.id;
    if (typeof id !== "number" && typeof id !== "string") return null;

    const baseSha = pullRequestBaseSha(run);

    return {
      provider: "github",
      ...repo,
      triggerType: "GITHUB_WORKFLOW_RUN",
      triggerExternalId: String(id),
      deliveryId,
      ...(baseSha ? { baseSha } : {}),
      ...(typeof run.head_sha === "string" ? { headSha: run.head_sha } : {}),
      failureSummary: `GitHub workflow_run completed with conclusion=${conclusion}`
    };
  }

  if (eventName === "check_run" && payload.action === "completed") {
    const run = (payload.check_run ?? {}) as Record<string, unknown>;
    const conclusion = typeof run.conclusion === "string" ? run.conclusion : null;
    if (!isIncidentConclusion(conclusion)) return null;
    const id = run.id;
    if (typeof id !== "number" && typeof id !== "string") return null;
    const suite = (run.check_suite ?? {}) as Record<string, unknown>;

    const baseSha = pullRequestBaseSha(run);

    return {
      provider: "github",
      ...repo,
      triggerType: "GITHUB_CHECK_RUN",
      triggerExternalId: String(id),
      deliveryId,
      ...(baseSha ? { baseSha } : {}),
      ...(typeof suite.head_sha === "string" ? { headSha: suite.head_sha } : {}),
      failureSummary: `GitHub check_run completed with conclusion=${conclusion}`
    };
  }

  return null;
}
