export const EVIDENCE_LIMITS = {
  maxRequests: 16,
  maxFailedJobs: 4,
  maxLogBytesPerJob: 256 * 1024,
  maxDownloadedLogBytes: 768 * 1024,
  maxItems: 48,
  maxEdges: 96,
  maxChangedFiles: 12,
  maxPatchItems: 8,
  maxPatchChars: 4_000,
  maxCheckOutputChars: 6_000
} as const;

// GitHub currently permits manual redelivery for deliveries from the past 3 days.
// Four days gives us one day of safety margin without retaining the replay ledger
// indefinitely on the D1 Free tier.
export const WEBHOOK_DELIVERY_RETENTION_MS = 4 * 24 * 60 * 60 * 1000;
export const WEBHOOK_DELIVERY_PRUNE_BATCH = 200;

// D1 Free permits 50 D1 queries per Worker invocation. Evidence persistence is
// capped at less than half of that budget so auth/audit/control queries retain
// headroom and a malicious incident cannot consume the entire invocation quota.
export const MAX_EVIDENCE_PERSISTENCE_STATEMENTS = 24;
