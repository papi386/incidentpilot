const INCIDENT_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "stale",
  "action_required"
]);

const SUCCESS_LIKE_CONCLUSIONS = new Set([
  "success",
  "neutral",
  "skipped",
  "cancelled"
]);

export function isIncidentConclusion(conclusion: string | null | undefined): boolean {
  return typeof conclusion === "string" && INCIDENT_CONCLUSIONS.has(conclusion);
}

export function isSuccessLikeConclusion(conclusion: string | null | undefined): boolean {
  return typeof conclusion === "string" && SUCCESS_LIKE_CONCLUSIONS.has(conclusion);
}

export function isDiagnosticFailureConclusion(conclusion: string | null | undefined): boolean {
  return isIncidentConclusion(conclusion);
}
