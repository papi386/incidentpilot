import { describe, expect, it } from "vitest";
import { verifyGitHubSignature } from "../src/security/github-signature";

describe("GitHub webhook signature", () => {
  it("matches GitHub's published SHA-256 test vector", async () => {
    const valid = await verifyGitHubSignature(
      "Hello, World!",
      "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17",
      "It's a Secret to Everybody"
    );
    expect(valid).toBe(true);
  });

  it("rejects an incorrect signature", async () => {
    const valid = await verifyGitHubSignature(
      "Hello, World!",
      "sha256=0000000000000000000000000000000000000000000000000000000000000000",
      "It's a Secret to Everybody"
    );
    expect(valid).toBe(false);
  });

  it("rejects a malformed signature", async () => {
    expect(await verifyGitHubSignature("x", "sha256=xyz", "secret")).toBe(false);
    expect(await verifyGitHubSignature("x", null, "secret")).toBe(false);
  });
});
