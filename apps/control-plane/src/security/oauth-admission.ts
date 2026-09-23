const WINDOW_MS = 60_000;
const MAX_ATTEMPTS_PER_WINDOW = 8;
const buckets = new Map<string, { windowStartedAt: number; count: number }>();
const MAX_BUCKETS = 2_000;

export function oauthAdmissionKey(ip: string | undefined): string {
  const normalized = (ip ?? "unknown").trim().toLowerCase();
  return normalized.length > 0 ? normalized.slice(0, 96) : "unknown";
}

export function allowOAuthAttempt(key: string, nowMs = Date.now()): boolean {
  const current = buckets.get(key);
  if (!current || nowMs - current.windowStartedAt >= WINDOW_MS) {
    if (buckets.size >= MAX_BUCKETS) {
      let oldestKey: string | undefined;
      let oldest = Number.POSITIVE_INFINITY;
      for (const [candidate, value] of buckets) {
        if (value.windowStartedAt < oldest) {
          oldest = value.windowStartedAt;
          oldestKey = candidate;
        }
      }
      if (oldestKey) buckets.delete(oldestKey);
    }
    buckets.set(key, { windowStartedAt: nowMs, count: 1 });
    return true;
  }

  if (current.count >= MAX_ATTEMPTS_PER_WINDOW) return false;
  current.count += 1;
  return true;
}

export const __testOnly = {
  reset(): void { buckets.clear(); },
  WINDOW_MS,
  MAX_ATTEMPTS_PER_WINDOW
};
