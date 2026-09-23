import { readCookie } from "./session-cookie";

export const OAUTH_BINDING_COOKIE = "incidentpilot_oauth_binding";
const OAUTH_BINDING_TTL_SECONDS = 10 * 60;

export function readOAuthBindingCookie(header: string | undefined): string | null {
  return readCookie(header, OAUTH_BINDING_COOKIE);
}

export function buildOAuthBindingCookie(token: string, secure: boolean): string {
  const attributes = [
    `${OAUTH_BINDING_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/auth/github/callback",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${OAUTH_BINDING_TTL_SECONDS}`
  ];

  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

export function buildExpiredOAuthBindingCookie(secure: boolean): string {
  const attributes = [
    `${OAUTH_BINDING_COOKIE}=`,
    "Path=/auth/github/callback",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0"
  ];

  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}
