import { describe, expect, it } from "vitest";
import type { EvidenceDraft, EvidenceEdgeDraft } from "@incidentpilot/domain";
import { EvidenceCipher } from "../src/security/evidence-crypto";

const key = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i + 1)));
const item: EvidenceDraft = {
  dedupeKey: "log:1", kind: "JOB_LOG_EXCERPT", sourceKind: "GITHUB_REDIRECT",
  integrity: "PROVIDER_AUTHENTICATED", contentClass: "UNTRUSTED_TEXT",
  sensitivity: "POTENTIALLY_SENSITIVE", instructionTrust: "NEVER_INSTRUCTIONS",
  content: "private failure detail", contentSha256: "a".repeat(64), metadata: { path: "src/x.ts" },
  collectedAt: "2026-09-10T00:00:00.000Z"
};

function envelope(incidentId: string, opaqueDedupeKey: string, encrypted: Awaited<ReturnType<EvidenceCipher["encryptItem"]>>) {
  return {
    incidentId,
    opaqueDedupeKey,
    kind: item.kind,
    sourceKind: item.sourceKind,
    integrity: item.integrity,
    contentClass: item.contentClass,
    sensitivity: item.sensitivity,
    instructionTrust: item.instructionTrust,
    collectedAt: item.collectedAt,
    ...encrypted
  } as const;
}

describe("evidence encryption", () => {
  it("round trips using only persisted opaque identity fields", async () => {
    const cipher = new EvidenceCipher(key, "v1");
    const opaque = await cipher.opaqueIndex(`incident-1:${item.dedupeKey}`);
    const encrypted = await cipher.encryptItem("incident-1", opaque, item);
    expect(atob(encrypted.ciphertextB64)).not.toContain(item.content);
    await expect(cipher.decryptItem(envelope("incident-1", opaque, encrypted))).resolves.toEqual(item);
  });

  it("produces opaque keyed indexes for repository-derived identifiers", async () => {
    const cipher = new EvidenceCipher(key, "v1");
    const raw = "changed-file:sha:token=abcdefghijk.txt";
    const index = await cipher.opaqueIndex(raw);
    expect(index).toMatch(/^[0-9a-f]{64}$/u);
    expect(index).not.toContain("token=");
    await expect(cipher.opaqueIndex(raw)).resolves.toBe(index);
  });

  it("rejects row swapping/tampering through authenticated persisted AAD", async () => {
    const cipher = new EvidenceCipher(key, "v1");
    const opaque = await cipher.opaqueIndex(`incident-1:${item.dedupeKey}`);
    const encrypted = await cipher.encryptItem("incident-1", opaque, item);
    await expect(cipher.decryptItem(envelope("incident-2", opaque, encrypted))).rejects.toThrow();
  });

  it("encrypts and recovers edge metadata from persisted edge identity", async () => {
    const cipher = new EvidenceCipher(key, "v1");
    const edge: EvidenceEdgeDraft = {
      fromDedupeKey: "stack:1",
      toDedupeKey: "file:1",
      relation: "POINTS_TO_FILE",
      metadata: { path: "secret-name.ts" }
    };
    const encrypted = await cipher.encryptEdgeMetadata("incident-1", "edge-1", "ev-a", "ev-b", edge, "2026-09-10T00:00:01.000Z");
    await expect(cipher.decryptEdgeMetadata({
      incidentId: "incident-1",
      edgeId: "edge-1",
      fromEvidenceId: "ev-a",
      toEvidenceId: "ev-b",
      relation: edge.relation,
      createdAt: "2026-09-10T00:00:01.000Z",
      ...encrypted
    })).resolves.toEqual(edge.metadata);
  });
});
