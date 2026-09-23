import { describe, expect, it } from "vitest";
import {
  OAUTH_BINDING_COOKIE,
  buildExpiredOAuthBindingCookie,
  buildOAuthBindingCookie,
  readOAuthBindingCookie
} from "../src/auth/oauth-binding-cookie";

describe("OAuth browser-binding cookie", () => {
  it("is HttpOnly, short-lived, and scoped to the callback", () => {
    const cookie = buildOAuthBindingCookie("browser-secret", true);
    expect(cookie).toContain(`${OAUTH_BINDING_COOKIE}=browser-secret`);
    expect(cookie).toContain("Path=/auth/github/callback");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("Max-Age=600");
  });

  it("can be read from the callback cookie header", () => {
    expect(readOAuthBindingCookie(`${OAUTH_BINDING_COOKIE}=abc123`)).toBe("abc123");
  });

  it("expires with the same callback path", () => {
    const cookie = buildExpiredOAuthBindingCookie(false);
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain("Path=/auth/github/callback");
  });
});
