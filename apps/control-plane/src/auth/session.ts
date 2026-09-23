import type { AppUser, AuthStore } from "@incidentpilot/domain";
import { randomUrlSafeToken } from "./random-token";
import { SESSION_COOKIE, buildSessionCookie, readCookie } from "./session-cookie";
import { sha256Hex } from "../security/sha256";

const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

export async function createSession(
  store: AuthStore,
  userId: string,
  secure: boolean
): Promise<{ cookie: string }> {
  const token = randomUrlSafeToken(32);
  const tokenHash = await sha256Hex(token);
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000);

  await store.createSession({
    id: crypto.randomUUID(),
    tokenHash,
    userId,
    createdAt: now.toISOString(),
    expiresAt: expires.toISOString()
  });

  return {
    cookie: buildSessionCookie(token, SESSION_TTL_SECONDS, secure)
  };
}

export async function resolveSessionUser(
  store: AuthStore,
  cookieHeader: string | undefined
): Promise<AppUser | null> {
  const token = readCookie(cookieHeader, SESSION_COOKIE);
  if (!token) return null;

  return store.getUserBySessionTokenHash(
    await sha256Hex(token),
    new Date().toISOString()
  );
}

export async function revokeSession(
  store: AuthStore,
  cookieHeader: string | undefined
): Promise<void> {
  const token = readCookie(cookieHeader, SESSION_COOKIE);
  if (!token) return;
  await store.revokeSession(await sha256Hex(token));
}
