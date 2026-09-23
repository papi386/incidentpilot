export type PrivateKeyFailure = "MISSING" | "ENCODING" | "FORMAT" | "ENCRYPTED" | "IMPORT";

export class PrivateKeyFormatError extends Error {
  constructor(public readonly reason: PrivateKeyFailure) {
    // Never include input or provider exception text in diagnostics.
    super(`GitHub App private key rejected (${reason})`);
  }
}

function base64Bytes(value: string): Uint8Array {
  try {
    const clean = value.replace(/\s/gu, "");
    if (!clean || !/^[A-Za-z0-9+/]+={0,2}$/u.test(clean)) throw new Error();
    return Uint8Array.from(atob(clean), (char) => char.charCodeAt(0));
  } catch {
    throw new PrivateKeyFormatError("ENCODING");
  }
}

function pemBytes(value: string): Uint8Array {
  const text = value.replace(/\\r\\n|\\n|\\r/gu, "\n").trim();
  if (text.includes("ENCRYPTED") || text.includes("Proc-Type:")) {
    throw new PrivateKeyFormatError("ENCRYPTED");
  }
  const match = /^-----BEGIN (RSA PRIVATE KEY|PRIVATE KEY)-----\s*([A-Za-z0-9+/=\s]+)\s*-----END \1-----$/u.exec(text);
  if (!match?.[2]) throw new PrivateKeyFormatError("FORMAT");
  return base64Bytes(match[2]);
}

function tlv(bytes: Uint8Array, offset: number): { tag: number; start: number; end: number } {
  const tag = bytes[offset++];
  let length = bytes[offset++];
  if (tag === undefined || length === undefined) throw new PrivateKeyFormatError("FORMAT");
  if (length & 0x80) {
    const count = length & 0x7f;
    if (count === 0 || count > 3) throw new PrivateKeyFormatError("FORMAT");
    length = 0;
    for (let i = 0; i < count; i++) {
      const byte = bytes[offset++];
      if (byte === undefined) throw new PrivateKeyFormatError("FORMAT");
      length = length * 256 + byte;
    }
  }
  if (offset + length > bytes.length) throw new PrivateKeyFormatError("FORMAT");
  return { tag, start: offset, end: offset + length };
}

function der(tag: number, content: Uint8Array): Uint8Array {
  const length: number[] = [];
  for (let n = content.length; n > 0; n = Math.floor(n / 256)) length.unshift(n % 256);
  const prefix = content.length < 128 ? [tag, content.length] : [tag, 0x80 | length.length, ...length];
  return new Uint8Array([...prefix, ...content]);
}

/** Normalize supported secret representations to DER PKCS#8 for Web Crypto. */
export function privateKeyPkcs8(value: unknown): ArrayBuffer {
  if (typeof value !== "string" || !value.trim()) throw new PrivateKeyFormatError("MISSING");
  if (value.length > 64 * 1024) throw new PrivateKeyFormatError("FORMAT");
  const text = value.trim();
  let bytes = text.startsWith("-----BEGIN ") ? pemBytes(text) : base64Bytes(text);
  // Base64 of a PEM file is distinct from base64 of its DER body.
  const decodedText = new TextDecoder().decode(bytes).trim();
  if (decodedText.startsWith("-----BEGIN ")) bytes = pemBytes(decodedText);

  const sequence = tlv(bytes, 0);
  if (sequence.tag !== 0x30 || sequence.end !== bytes.length) throw new PrivateKeyFormatError("FORMAT");
  const version = tlv(bytes, sequence.start);
  if (version.tag !== 0x02) throw new PrivateKeyFormatError("FORMAT");
  const second = tlv(bytes, version.end);
  if (second.tag === 0x02) {
    // RSA PKCS#1: wrap the existing DER in a PKCS#8 PrivateKeyInfo envelope.
    // rsaEncryption OID 1.2.840.113549.1.1.1 with NULL parameters.
    const algorithm = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
    bytes = der(0x30, new Uint8Array([0x02, 0x01, 0x00, ...algorithm, ...der(0x04, bytes)]));
  } else if (second.tag !== 0x30) {
    throw new PrivateKeyFormatError("FORMAT");
  }
  // Copy to an ordinary ArrayBuffer; Web Crypto validates the RSA key itself.
  return Uint8Array.from(bytes).buffer;
}
