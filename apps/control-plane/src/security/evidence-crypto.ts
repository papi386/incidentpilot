import type {
  EvidenceDraft,
  EvidenceEdgeDraft,
  EvidenceKind,
  EvidenceSourceKind,
  EvidenceIntegrity,
  EvidenceContentClass,
  EvidenceSensitivity,
  EvidenceEdgeRelation,
  JsonObject
} from "@incidentpilot/domain";

const NONCE_BYTES = 12;
const KEY_BYTES = 32;

function decodeBase64(value: string): Uint8Array {
  try {
    const cleaned = value.trim().replace(/\s+/gu, "");
    const binary = atob(cleaned);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    throw new Error("Evidence encryption key is not valid base64");
  }
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export interface EncryptedEvidenceContent {
  ciphertextB64: string;
  nonceB64: string;
  aadVersion: 2;
  keyVersion: string;
}

export interface PersistedEvidenceItemEnvelope extends EncryptedEvidenceContent {
  incidentId: string;
  opaqueDedupeKey: string;
  kind: EvidenceKind;
  sourceKind: EvidenceSourceKind;
  integrity: EvidenceIntegrity;
  contentClass: EvidenceContentClass;
  sensitivity: EvidenceSensitivity;
  instructionTrust: "NEVER_INSTRUCTIONS";
  collectedAt: string;
}

export interface PersistedEvidenceEdgeEnvelope extends EncryptedEvidenceContent {
  incidentId: string;
  edgeId: string;
  fromEvidenceId: string;
  toEvidenceId: string;
  relation: EvidenceEdgeRelation;
  createdAt: string;
}

function buildItemAad(input: Omit<PersistedEvidenceItemEnvelope, keyof EncryptedEvidenceContent>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    v: 2,
    type: "evidence-item",
    incidentId: input.incidentId,
    opaqueDedupeKey: input.opaqueDedupeKey,
    kind: input.kind,
    sourceKind: input.sourceKind,
    integrity: input.integrity,
    contentClass: input.contentClass,
    sensitivity: input.sensitivity,
    instructionTrust: input.instructionTrust,
    collectedAt: input.collectedAt
  }));
}

function buildEdgeAad(input: Omit<PersistedEvidenceEdgeEnvelope, keyof EncryptedEvidenceContent>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    v: 2,
    type: "evidence-edge",
    incidentId: input.incidentId,
    edgeId: input.edgeId,
    fromEvidenceId: input.fromEvidenceId,
    toEvidenceId: input.toEvidenceId,
    relation: input.relation,
    createdAt: input.createdAt
  }));
}

function assertObject(value: unknown, message: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as JsonObject;
}

export class EvidenceCipher {
  private importedKey?: Promise<CryptoKey>;
  private importedIndexKey?: Promise<CryptoKey>;

  constructor(
    private readonly keyB64: string,
    private readonly keyVersion: string
  ) {
    if (!/^[A-Za-z0-9._-]{1,32}$/u.test(keyVersion)) throw new Error("Evidence encryption key version is invalid");
  }

  private rawKey(): Uint8Array {
    const raw = decodeBase64(this.keyB64);
    if (raw.byteLength !== KEY_BYTES) throw new Error("Evidence encryption key must decode to exactly 32 bytes");
    return raw;
  }

  private getKey(): Promise<CryptoKey> {
    if (!this.importedKey) {
      this.importedKey = crypto.subtle.importKey(
        "raw",
        toArrayBuffer(this.rawKey()),
        { name: "AES-GCM" },
        false,
        ["encrypt", "decrypt"]
      );
    }
    return this.importedKey;
  }

  private getIndexKey(): Promise<CryptoKey> {
    if (!this.importedIndexKey) {
      this.importedIndexKey = crypto.subtle.importKey(
        "raw",
        toArrayBuffer(this.rawKey()),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
      );
    }
    return this.importedIndexKey;
  }

  async opaqueIndex(value: string): Promise<string> {
    const signature = await crypto.subtle.sign(
      "HMAC",
      await this.getIndexKey(),
      new TextEncoder().encode(`incidentpilot:evidence-index:v1:${value}`)
    );
    return bytesToHex(new Uint8Array(signature));
  }

  async encryptItem(
    incidentId: string,
    opaqueDedupeKey: string,
    item: EvidenceDraft
  ): Promise<EncryptedEvidenceContent> {
    const key = await this.getKey();
    const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
    const identity = {
      incidentId,
      opaqueDedupeKey,
      kind: item.kind,
      sourceKind: item.sourceKind,
      integrity: item.integrity,
      contentClass: item.contentClass,
      sensitivity: item.sensitivity,
      instructionTrust: item.instructionTrust,
      collectedAt: item.collectedAt
    } as const;
    const plaintext = new TextEncoder().encode(JSON.stringify({
      dedupeKey: item.dedupeKey,
      sourceExternalId: item.sourceExternalId ?? null,
      sourceUrl: item.sourceUrl ?? null,
      content: item.content,
      contentSha256: item.contentSha256,
      metadata: item.metadata
    }));
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: toArrayBuffer(nonce),
        additionalData: toArrayBuffer(buildItemAad(identity)),
        tagLength: 128
      },
      key,
      plaintext
    );
    return {
      ciphertextB64: encodeBase64(new Uint8Array(ciphertext)),
      nonceB64: encodeBase64(nonce),
      aadVersion: 2,
      keyVersion: this.keyVersion
    };
  }

  async decryptItem(envelope: PersistedEvidenceItemEnvelope): Promise<EvidenceDraft> {
    if (envelope.aadVersion !== 2 || envelope.keyVersion !== this.keyVersion) {
      throw new Error("Unsupported evidence encryption metadata");
    }
    const nonce = decodeBase64(envelope.nonceB64);
    if (nonce.byteLength !== NONCE_BYTES) throw new Error("Evidence nonce is invalid");
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: toArrayBuffer(nonce),
        additionalData: toArrayBuffer(buildItemAad(envelope)),
        tagLength: 128
      },
      await this.getKey(),
      toArrayBuffer(decodeBase64(envelope.ciphertextB64))
    );
    const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, unknown>;
    if (typeof parsed.dedupeKey !== "string" || typeof parsed.content !== "string" || typeof parsed.contentSha256 !== "string") {
      throw new Error("Encrypted evidence record is malformed");
    }
    return {
      dedupeKey: parsed.dedupeKey,
      kind: envelope.kind,
      sourceKind: envelope.sourceKind,
      ...(typeof parsed.sourceExternalId === "string" ? { sourceExternalId: parsed.sourceExternalId } : {}),
      ...(typeof parsed.sourceUrl === "string" ? { sourceUrl: parsed.sourceUrl } : {}),
      integrity: envelope.integrity,
      contentClass: envelope.contentClass,
      sensitivity: envelope.sensitivity,
      instructionTrust: envelope.instructionTrust,
      content: parsed.content,
      contentSha256: parsed.contentSha256,
      metadata: assertObject(parsed.metadata, "Encrypted evidence metadata is malformed"),
      collectedAt: envelope.collectedAt
    };
  }

  async encryptEdgeMetadata(
    incidentId: string,
    edgeId: string,
    fromEvidenceId: string,
    toEvidenceId: string,
    edge: EvidenceEdgeDraft,
    createdAt: string
  ): Promise<EncryptedEvidenceContent> {
    const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
    const identity = {
      incidentId,
      edgeId,
      fromEvidenceId,
      toEvidenceId,
      relation: edge.relation,
      createdAt
    } as const;
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: toArrayBuffer(nonce),
        additionalData: toArrayBuffer(buildEdgeAad(identity)),
        tagLength: 128
      },
      await this.getKey(),
      new TextEncoder().encode(JSON.stringify({ metadata: edge.metadata }))
    );
    return {
      ciphertextB64: encodeBase64(new Uint8Array(ciphertext)),
      nonceB64: encodeBase64(nonce),
      aadVersion: 2,
      keyVersion: this.keyVersion
    };
  }

  async decryptEdgeMetadata(envelope: PersistedEvidenceEdgeEnvelope): Promise<JsonObject> {
    if (envelope.aadVersion !== 2 || envelope.keyVersion !== this.keyVersion) {
      throw new Error("Unsupported evidence encryption metadata");
    }
    const nonce = decodeBase64(envelope.nonceB64);
    if (nonce.byteLength !== NONCE_BYTES) throw new Error("Evidence nonce is invalid");
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: toArrayBuffer(nonce),
        additionalData: toArrayBuffer(buildEdgeAad(envelope)),
        tagLength: 128
      },
      await this.getKey(),
      toArrayBuffer(decodeBase64(envelope.ciphertextB64))
    );
    const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, unknown>;
    return assertObject(parsed.metadata, "Encrypted evidence edge metadata is malformed");
  }
}
