import { beforeEach, describe, expect, it } from "vitest";
import { __testOnly, allowOAuthAttempt, oauthAdmissionKey } from "../src/security/oauth-admission";

describe("OAuth admission limiter", () => {
  beforeEach(() => __testOnly.reset());

  it("rejects bursts before D1 flow creation and resets after the window", () => {
    const key = oauthAdmissionKey("203.0.113.10");
    for (let i = 0; i < __testOnly.MAX_ATTEMPTS_PER_WINDOW; i += 1) {
      expect(allowOAuthAttempt(key, 1_000)).toBe(true);
    }
    expect(allowOAuthAttempt(key, 1_001)).toBe(false);
    expect(allowOAuthAttempt(key, 1_000 + __testOnly.WINDOW_MS)).toBe(true);
  });

  it("does not let User-Agent rotation create fresh rate-limit identities", () => {
    const ipOnly = oauthAdmissionKey("203.0.113.10");
    expect(ipOnly).toBe("203.0.113.10");
    for (let i = 0; i < __testOnly.MAX_ATTEMPTS_PER_WINDOW; i += 1) {
      expect(allowOAuthAttempt(oauthAdmissionKey("203.0.113.10"), 2_000)).toBe(true);
    }
    expect(allowOAuthAttempt(oauthAdmissionKey("203.0.113.10"), 2_001)).toBe(false);
  });
});
