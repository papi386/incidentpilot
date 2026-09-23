export type D1ResourceExhaustionKind =
  | "ROW_READ_LIMIT"
  | "ROW_WRITE_LIMIT"
  | "DATABASE_SIZE_LIMIT"
  | "ACCOUNT_STORAGE_LIMIT";

export interface D1ResourceExhaustion {
  kind: D1ResourceExhaustionKind;
  retryAfterSeconds: number;
}

const READ_LIMIT_FRAGMENT = "exceeded d1's free tier daily row read limit";
const WRITE_LIMIT_FRAGMENT = "exceeded d1's free tier daily row write limit";
const SIZE_LIMIT_FRAGMENT = "exceeded maximum db size";
const ACCOUNT_STORAGE_LIMIT_FRAGMENT = "exceeded d1's maximum account storage limit";

export function secondsUntilNextUtcMidnight(now = new Date()): number {
  const next = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0,
    0,
    0,
    0
  );
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.toLowerCase();
  if (typeof error === "string") return error.toLowerCase();
  return "";
}

export function classifyD1ResourceExhaustion(
  error: unknown,
  now = new Date()
): D1ResourceExhaustion | null {
  const message = errorMessage(error);

  if (message.includes(READ_LIMIT_FRAGMENT)) {
    return {
      kind: "ROW_READ_LIMIT",
      retryAfterSeconds: secondsUntilNextUtcMidnight(now)
    };
  }

  if (message.includes(WRITE_LIMIT_FRAGMENT)) {
    return {
      kind: "ROW_WRITE_LIMIT",
      retryAfterSeconds: secondsUntilNextUtcMidnight(now)
    };
  }

  if (message.includes(ACCOUNT_STORAGE_LIMIT_FRAGMENT)) {
    return {
      kind: "ACCOUNT_STORAGE_LIMIT",
      retryAfterSeconds: 60 * 60
    };
  }

  if (message.includes(SIZE_LIMIT_FRAGMENT)) {
    // Capacity does not self-heal at midnight. Keep the HTTP retry hint bounded,
    // but classify it separately so operators know cleanup/upgrade is required.
    return {
      kind: "DATABASE_SIZE_LIMIT",
      retryAfterSeconds: 60 * 60
    };
  }

  return null;
}

const WORKFLOW_RESOURCE_PREFIX = "D1_RESOURCE_EXHAUSTED:";

export function workflowResourceExhaustionMessage(
  exhaustion: D1ResourceExhaustion
): string {
  return `${WORKFLOW_RESOURCE_PREFIX}${exhaustion.kind}:${exhaustion.retryAfterSeconds}`;
}

export function parseWorkflowResourceExhaustion(error: unknown): D1ResourceExhaustion | null {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const index = message.indexOf(WORKFLOW_RESOURCE_PREFIX);
  if (index < 0) return null;

  const payload = message.slice(index + WORKFLOW_RESOURCE_PREFIX.length);
  const [kindRaw, retryRaw] = payload.split(":", 2);
  if (
    kindRaw !== "ROW_READ_LIMIT" &&
    kindRaw !== "ROW_WRITE_LIMIT" &&
    kindRaw !== "DATABASE_SIZE_LIMIT" &&
    kindRaw !== "ACCOUNT_STORAGE_LIMIT"
  ) {
    return null;
  }

  const retryAfterSeconds = Number(retryRaw);
  if (!Number.isFinite(retryAfterSeconds) || retryAfterSeconds <= 0) return null;

  return {
    kind: kindRaw,
    retryAfterSeconds: Math.floor(retryAfterSeconds)
  };
}
