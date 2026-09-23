import { describe, expect, it } from "vitest";
import { redactSensitiveText } from "../src/evidence/redaction";

describe("redactSensitiveText", () => {
  it("redacts common credentials without deleting surrounding diagnostic text", () => {
    const input = [
      "Authorization: Bearer super-secret-bearer-value",
      "token=github_pat_abcdefghijklmnopqrstuvwxyz123456",
      "AWS=AKIA1234567890ABCDEF",
      "database error after authentication"
    ].join("\n");

    const result = redactSensitiveText(input);

    expect(result.text).not.toContain("super-secret-bearer-value");
    expect(result.text).not.toContain("github_pat_abcdefghijklmnopqrstuvwxyz123456");
    expect(result.text).not.toContain("AKIA1234567890ABCDEF");
    expect(result.text).toContain("database error after authentication");
    expect(result.count).toBeGreaterThanOrEqual(3);
  });

  it("redacts PEM private keys", () => {
    const result = redactSensitiveText(
      "-----BEGIN RSA PRIVATE KEY-----\nabc123\n-----END RSA PRIVATE KEY-----"
    );
    expect(result.text).toBe("[REDACTED_PRIVATE_KEY]");
  });

  it("redacts quoted JSON-style secret assignments", () => {
    const result = redactSensitiveText('{"client_secret":"super-secret-value-123","token":"abcdefghi123456789"}');
    expect(result.text).not.toContain("super-secret-value-123");
    expect(result.text).not.toContain("abcdefghi123456789");
    expect(result.text).toContain("[REDACTED]");
  });
});
