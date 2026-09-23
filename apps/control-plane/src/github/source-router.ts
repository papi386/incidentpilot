import type { IncidentTrigger } from "@incidentpilot/domain";
import { normalizeGitHubEvent } from "./normalize-event";

export type SourceDisposition = "CANONICAL_TRIGGER" | "SUPPORTING_ONLY" | "INDEPENDENT_TRIGGER" | "PENDING_VERIFICATION" | "REJECTED";
export interface SourceRouting {
  disposition: SourceDisposition;
  reason: string;
  repositoryId?: string | undefined;
  installationId?: string | undefined;
  sourceId?: string | undefined;
  appId?: string | undefined;
  checkSuiteId?: string | undefined;
  trigger?: IncidentTrigger;
}

// GitHub.com first-party app identity, not a user-editable check name/URL.
// Enterprise hosts require a separate reviewed identity configuration.
export const GITHUB_ACTIONS_APP_ID = "15368";
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function providerId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  return undefined;
}

/** Called only after exact-byte HMAC verification. No provider URLs are fetched. */
export async function routeGitHubSource(db: D1Database, event: string, deliveryId: string, input: unknown): Promise<SourceRouting> {
  const payload = object(input);
  const repository = object(payload.repository);
  const source = object(event === "workflow_run" ? payload.workflow_run : payload.check_run);
  const app = object(source.app);
  const ids = {
    repositoryId: providerId(repository.id),
    installationId: providerId(object(payload.installation).id),
    sourceId: providerId(source.id),
    appId: providerId(app.id),
    checkSuiteId: providerId(event === "workflow_run" ? source.check_suite_id : object(source.check_suite).id)
  };
  const result = (disposition: SourceDisposition, reason: string): SourceRouting => ({ ...ids, disposition, reason });
  if (!ids.repositoryId || !ids.sourceId || typeof repository.full_name !== "string"
      || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository.full_name)) {
    return result("REJECTED", "INVALID_PROVIDER_FIELDS");
  }
  const trigger = normalizeGitHubEvent(event, deliveryId, payload);
  if (!trigger) return result("REJECTED", "NOT_A_FAILURE_TRIGGER");
  if (!ids.installationId) return result("PENDING_VERIFICATION", "MISSING_INSTALLATION");
  const installation = await db.prepare("SELECT suspended_at, permissions_json FROM github_installations WHERE external_id = ?")
    .bind(ids.installationId).first<{ suspended_at: string | null; permissions_json: string }>();
  if (!installation) return result("PENDING_VERIFICATION", "UNKNOWN_INSTALLATION");
  if (installation.suspended_at) return result("REJECTED", "INSTALLATION_SUSPENDED");
  if (event === "check_run") {
    if (!ids.appId) return result("PENDING_VERIFICATION", "MISSING_PROVIDER_IDENTITY");
    if (ids.appId === GITHUB_ACTIONS_APP_ID) {
      if (app.slug !== "github-actions") return result("PENDING_VERIFICATION", "INCONSISTENT_PROVIDER_IDENTITY");
      return result("SUPPORTING_ONLY", "GITHUB_ACTIONS_CHECK");
    }
    if (app.slug === "github-actions") return result("PENDING_VERIFICATION", "INCONSISTENT_PROVIDER_IDENTITY");
    const trusted = await db.prepare(`SELECT enabled FROM trusted_check_providers
      WHERE installation_external_id = ? AND repository_external_id = ? AND app_id = ?`)
      .bind(ids.installationId, ids.repositoryId, ids.appId).first<{ enabled: number }>();
    if (trusted?.enabled !== 1) return result("PENDING_VERIFICATION", "PROVIDER_NOT_APPROVED");
  }
  let permissions: Record<string, unknown> = {};
  try { permissions = object(JSON.parse(installation.permissions_json)); } catch { /* Deny below. */ }
  const readable = (key: string) => permissions[key] === "read" || permissions[key] === "write";
  if (!readable("contents") || !readable(event === "workflow_run" ? "actions" : "checks")) {
    return result("REJECTED", "INSUFFICIENT_PERMISSIONS");
  }
  return { ...result(event === "workflow_run" ? "CANONICAL_TRIGGER" : "INDEPENDENT_TRIGGER", event === "workflow_run" ? "GITHUB_ACTIONS_WORKFLOW" : "APPROVED_CHECK_PROVIDER"), trigger };
}
