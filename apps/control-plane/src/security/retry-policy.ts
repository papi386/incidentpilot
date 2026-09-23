import { GitHubApiError } from "../github/github-api";
import { GitHubAuthError } from "../github/github-app-auth";

const MAX_PROVIDER_DELAY_MS = 5 * 60 * 1000;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function evidenceRetryDelayMs(attempt: number, error: unknown): number {
  const providerDelay = error instanceof GitHubApiError || error instanceof GitHubAuthError
    ? error.retryAfterMs
    : undefined;
  if (providerDelay !== undefined) {
    return clamp(providerDelay, 1_000, MAX_PROVIDER_DELAY_MS);
  }

  // Exponential backoff plus bounded jitter avoids synchronized retry storms.
  const base = Math.min(5_000 * (2 ** Math.max(0, attempt - 1)), 60_000);
  const jitter = Math.floor(Math.random() * Math.max(250, Math.floor(base * 0.2)));
  return base + jitter;
}
