import { beforeAll, describe, expect, it, vi } from "vitest";
import { GitHubAppTokenBroker } from "../src/github/github-app-auth";

let pkcs8: Uint8Array;
let pkcs1: Uint8Array;
let publicKey: CryptoKey;
const now = 1_800_000_000_000;

function b64(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
}
function pem(label: string, bytes: Uint8Array): string {
  return `-----BEGIN ${label}-----\n${b64(bytes).match(/.{1,64}/gu)!.join("\n")}\n-----END ${label}-----\n`;
}
function field(bytes: Uint8Array, offset: number) {
  const tag = bytes[offset++];
  let length = bytes[offset++]!;
  if (length & 0x80) {
    const count = length & 0x7f;
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + bytes[offset++]!;
  }
  return { tag, start: offset, end: offset + length };
}

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({
    name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256"
  }, true, ["sign", "verify"]);
  publicKey = pair.publicKey;
  pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const sequence = field(pkcs8, 0);
  const version = field(pkcs8, sequence.start);
  const algorithm = field(pkcs8, version.end);
  const key = field(pkcs8, algorithm.end);
  expect(key.tag).toBe(4);
  pkcs1 = pkcs8.slice(key.start, key.end);
});

describe("GitHub App secret representations", () => {
  const cases: Array<[string, () => string]> = [
    ["base64 DER PKCS#8", () => b64(pkcs8)],
    ["base64 DER PKCS#1", () => b64(pkcs1)],
    ["PKCS#8 PEM", () => pem("PRIVATE KEY", pkcs8)],
    ["GitHub PKCS#1 PEM", () => pem("RSA PRIVATE KEY", pkcs1)],
    ["base64 PKCS#8 PEM file", () => b64(new TextEncoder().encode(pem("PRIVATE KEY", pkcs8)))],
    ["base64 GitHub PEM file", () => b64(new TextEncoder().encode(pem("RSA PRIVATE KEY", pkcs1)))],
    ["escaped PEM newlines", () => pem("RSA PRIVATE KEY", pkcs1).replace(/\n/gu, "\\n")],
    ["wrapped base64 and BOM", () => `\uFEFF ${b64(pkcs8).match(/.{1,64}/gu)!.join("\r\n")} \n`]
  ];
  for (const [name, secret] of cases) {
    it(`signs a verifiable JWT and reaches token minting with ${name}`, async () => {
      let jwt = "";
      const fetcher = vi.fn(async (_url: string | URL, init?: RequestInit) => {
        jwt = new Headers(init?.headers).get("Authorization")!.slice(7);
        expect(JSON.parse(String(init?.body))).toEqual({ repository_ids: [42], permissions: { actions: "read", contents: "read" } });
        return Response.json({ token: "test-only", expires_at: "2099-01-01T00:00:00Z" });
      });
      const broker = new GitHubAppTokenBroker("Iv1.test", secret(), fetcher);
      const signed = await broker.createAppJwt(now);
      const [header, payload, signature] = signed.split(".");
      const bytes = Uint8Array.from(atob(signature!.replace(/-/gu, "+").replace(/_/gu, "/")), c => c.charCodeAt(0));
      expect(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, bytes, new TextEncoder().encode(`${header}.${payload}`))).toBe(true);
      expect(JSON.parse(atob(payload!))).toEqual({ iss: "Iv1.test", iat: now / 1000 - 60, exp: now / 1000 + 540 });
      await expect(broker.createInstallationToken({ installationExternalId: "7", repositoryExternalId: "42", permissions: ["actions", "contents"] })).resolves.toMatchObject({ token: "test-only" });
      expect(fetcher).toHaveBeenCalledOnce();
      expect(jwt.split(".")).toHaveLength(3);
    });
  }

  it.each([
    ["", "MISSING"],
    ["not-a-key!", "ENCODING"],
    [btoa("not DER"), "FORMAT"],
    ["-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----", "ENCRYPTED"],
    ["-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----", "FORMAT"],
    ["x".repeat(65_537), "FORMAT"]
  ])("rejects invalid input case %# before any HTTP request", async (secret, reason) => {
    const fetcher = vi.fn();
    const broker = new GitHubAppTokenBroker("Iv1.test", secret, fetcher);
    await expect(broker.createInstallationToken({ installationExternalId: "7", repositoryExternalId: "42", permissions: ["contents"] })).rejects.toMatchObject({ code: "INVALID_PRIVATE_KEY", privateKeyFailure: reason });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reports Web Crypto rejection without exposing key material", async () => {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const secret = b64(new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey)));
    await expect(new GitHubAppTokenBroker("Iv1.test", secret).createAppJwt()).rejects.toMatchObject({
      code: "INVALID_PRIVATE_KEY", privateKeyFailure: "IMPORT", message: "GitHub App private key rejected (IMPORT)"
    });
  });
});
