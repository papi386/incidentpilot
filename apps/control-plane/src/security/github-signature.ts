function hexToArrayBuffer(hex: string): ArrayBuffer | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]+$/iu.test(hex)) return null;
  const buffer = new ArrayBuffer(hex.length / 2);
  const output = new Uint8Array(buffer);
  for (let i = 0; i < output.length; i += 1) {
    output[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return buffer;
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

export async function verifyGitHubSignature(
  rawBody: string | Uint8Array,
  signatureHeader: string | null,
  secret: string
): Promise<boolean> {
  if (!signatureHeader?.startsWith("sha256=") || !secret) return false;

  const received = hexToArrayBuffer(signatureHeader.slice("sha256=".length));
  if (!received) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const data = typeof rawBody === "string"
    ? new TextEncoder().encode(rawBody)
    : rawBody;

  return crypto.subtle.verify(
    "HMAC",
    key,
    received,
    toArrayBuffer(data)
  );
}
