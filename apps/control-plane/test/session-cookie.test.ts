import { describe, expect, it } from "vitest";
import {
  SESSION_COOKIE,
  buildExpiredSessionCookie,
  buildSessionCookie,
  readCookie
} from "../src/auth/session-cookie";

describe("session cookies", () => {
  it("reads the IncidentPilot session among multiple cookies", () => {
    expect(readCookie("a=1; incidentpilot_session=abc123; b=2", SESSION_COOKIE))
      .toBe("abc123");
  });

  it("sets secure server-only cookie attributes in HTTPS mode", () => {
    const cookie = buildSessionCookie("secret-token", 60, true);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("Max-Age=60");
  });

  it("expires the same cookie name", () => {
    expect(buildExpiredSessionCookie(false)).toContain(`${SESSION_COOKIE}=`);
    expect(buildExpiredSessionCookie(false)).toContain("Max-Age=0");
  });
});
