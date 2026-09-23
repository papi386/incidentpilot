import { beforeAll, describe, expect, it } from "vitest";
import { GitHubAppTokenBroker } from "../src/github/github-app-auth";

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

describe("GitHub App token broker deadlines", () => {
  let privateKeyB64 = "";

  beforeAll(async () => {
    const pair = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256"
      },
      true,
      ["sign", "verify"]
    );
    const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
    privateKeyB64 = arrayBufferToBase64(pkcs8);
  });

  it("keeps the deadline active while the token response body is streaming", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"token":"'));
        setTimeout(() => {
          controller.enqueue(new TextEncoder().encode('late","expires_at":"2099-01-01T00:00:00Z"}'));
          controller.close();
        }, 75);
      }
    });

    const broker = new GitHubAppTokenBroker(
      "Iv1.test-client-id",
      privateKeyB64,
      async () => new Response(stream, { status: 201 }),
      10
    );

    await expect(broker.createInstallationToken({
      installationExternalId: "123",
      repositoryExternalId: "456",
      permissions: ["actions", "contents"]
    })).rejects.toMatchObject({
      code: "TOKEN_REQUEST_TIMEOUT"
    });
  });
});
