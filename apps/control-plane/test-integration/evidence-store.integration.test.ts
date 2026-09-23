import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { EvidenceDraft, EvidenceEdgeDraft } from "@incidentpilot/domain";
import { D1EvidenceStore } from "../src/adapters/d1-evidence-store";
import { EvidenceCipher } from "../src/security/evidence-crypto";

const key = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i + 1)));
const cipher = new EvidenceCipher(key, "v1");

const items: EvidenceDraft[] = [
  {
    dedupeKey: "file:token=abcdefghijk.txt",
    kind: "CHANGED_FILE",
    sourceKind: "GITHUB_API",
    sourceExternalId: "file-1",
    sourceUrl: "https://api.github.com/repos/acme/repo/contents/token=abcdefghijk.txt",
    integrity: "PROVIDER_AUTHENTICATED",
    contentClass: "STRUCTURED_METADATA",
    sensitivity: "POTENTIALLY_SENSITIVE",
    instructionTrust: "NEVER_INSTRUCTIONS",
    content: "token=abcdefghijk.txt",
    contentSha256: "a".repeat(64),
    metadata: { path: "token=abcdefghijk.txt", status: "modified" },
    collectedAt: "2026-09-11T12:00:00.000Z"
  },
  {
    dedupeKey: "stack:1",
    kind: "STACK_FRAME",
    sourceKind: "DERIVED",
    integrity: "DERIVED_FROM_AUTHENTICATED",
    contentClass: "STRUCTURED_METADATA",
    sensitivity: "NORMAL",
    instructionTrust: "NEVER_INSTRUCTIONS",
    content: "token=abcdefghijk.txt:42",
    contentSha256: "b".repeat(64),
    metadata: { line: 42 },
    collectedAt: "2026-09-11T12:00:01.000Z"
  }
];

const edges: EvidenceEdgeDraft[] = [
  {
    fromDedupeKey: "stack:1",
    toDedupeKey: "file:token=abcdefghijk.txt",
    relation: "POINTS_TO_FILE",
    metadata: { path: "token=abcdefghijk.txt", confidence: 1 }
  }
];

const run = {
  idempotencyKey: "evidence-collection:github:inc-1",
  incidentId: "inc-1",
  source: "github" as const,
  startedAt: "2026-09-11T12:00:00.000Z",
  completedAt: "2026-09-11T12:00:02.000Z",
  summary: {
    status: "COMPLETED" as const,
    requestsUsed: 4,
    downloadedBytes: 100,
    itemsProduced: 2,
    edgesProduced: 1,
    truncated: false,
    errorCodes: [],
    baseResolution: "HEAD_PARENT" as const
  }
};

async function seedIncident() {
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO repositories (id, provider, external_id, full_name, installation_external_id, created_at, updated_at) VALUES (?, 'github', ?, ?, ?, ?, ?)`).bind(
      "repo-1", "1", "acme/repo", "inst-1", run.startedAt, run.startedAt
    ),
    env.DB.prepare(`INSERT OR IGNORE INTO incidents (id, repository_id, dedupe_key, trigger_type, trigger_external_id, failure_summary, status, created_at, updated_at) VALUES (?, ?, ?, 'GITHUB_WORKFLOW_RUN', ?, ?, 'CONTEXT_BUILDING', ?, ?)`).bind(
      run.incidentId, "repo-1", "dedupe-1", "123", "failed", run.startedAt, run.startedAt
    )
  ]);
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM evidence_edges"),
    env.DB.prepare("DELETE FROM evidence_items"),
    env.DB.prepare("DELETE FROM evidence_collection_runs"),
    env.DB.prepare("DELETE FROM audit_events"),
    env.DB.prepare("DELETE FROM incidents"),
    env.DB.prepare("DELETE FROM repositories")
  ]);
  await seedIncident();
});

describe("D1EvidenceStore recovery", () => {
  it("saves, discards drafts, reloads and decrypts complete items and edge metadata", async () => {
    const store = new D1EvidenceStore(env.DB, cipher);
    await store.saveCollection(run, structuredClone(items), structuredClone(edges));

    const rawItem = await env.DB.prepare("SELECT dedupe_key, source_external_id, source_url, metadata_json, ciphertext_b64, aad_version FROM evidence_items LIMIT 1").first<Record<string, unknown>>();
    expect(rawItem?.dedupe_key).toMatch(/^[0-9a-f]{64}$/u);
    expect(rawItem?.dedupe_key).not.toContain("token=");
    expect(rawItem?.source_external_id).toBeNull();
    expect(rawItem?.source_url).toBeNull();
    expect(rawItem?.metadata_json).toBe('{"protected":true}');
    expect(rawItem?.ciphertext_b64).not.toContain("token=");
    expect(rawItem?.aad_version).toBe(2);

    const rawEdge = await env.DB.prepare("SELECT metadata_json, ciphertext_b64, aad_version FROM evidence_edges LIMIT 1").first<Record<string, unknown>>();
    expect(rawEdge?.metadata_json).toBe('{"protected":true}');
    expect(rawEdge?.ciphertext_b64).not.toContain("token=");
    expect(rawEdge?.aad_version).toBe(2);

    const loaded = await store.loadCollection(run.incidentId);
    expect(loaded.items).toEqual(items);
    expect(loaded.edges).toEqual(edges);
  });

  it("rolls back replacement when a later edge insert fails", async () => {
    const store = new D1EvidenceStore(env.DB, cipher);
    await store.saveCollection(run, structuredClone(items), structuredClone(edges));
    const before = await store.loadCollection(run.incidentId);

    await env.DB.prepare(`
      CREATE TRIGGER fail_evidence_edges BEFORE INSERT ON evidence_edges
      BEGIN SELECT RAISE(ABORT, 'forced edge failure'); END
    `).run();

    const changed = structuredClone(items);
    changed[0]!.content = "replacement-content";
    await expect(store.saveCollection({ ...run, idempotencyKey: "replacement" }, changed, structuredClone(edges))).rejects.toThrow();
    await env.DB.prepare("DROP TRIGGER fail_evidence_edges").run();

    const after = await store.loadCollection(run.incidentId);
    expect(after).toEqual(before);
  });

  it("persists and reloads the maximum bounded graph through the real D1 adapter", async () => {
    const store = new D1EvidenceStore(env.DB, cipher);
    const maxItems: EvidenceDraft[] = Array.from({ length: 48 }, (_, index) => ({
      dedupeKey: `max-item:${index}`,
      kind: index % 2 === 0 ? "ERROR_SIGNAL" : "STACK_FRAME",
      sourceKind: "DERIVED",
      integrity: "DERIVED_FROM_AUTHENTICATED",
      contentClass: "STRUCTURED_METADATA",
      sensitivity: "NORMAL",
      instructionTrust: "NEVER_INSTRUCTIONS",
      content: `item-${index}`,
      contentSha256: index.toString(16).padStart(64, "0"),
      metadata: { index },
      collectedAt: `2026-09-11T12:00:${String(index).padStart(2, "0")}.000Z`
    }));
    const maxEdges: EvidenceEdgeDraft[] = [];
    for (let from = 0; from < 48 && maxEdges.length < 96; from += 1) {
      for (let offset = 1; offset <= 2 && maxEdges.length < 96; offset += 1) {
        maxEdges.push({
          fromDedupeKey: `max-item:${from}`,
          toDedupeKey: `max-item:${(from + offset) % 48}`,
          relation: offset === 1 ? "RELATED_TO" : "POINTS_TO_FILE",
          metadata: { from, offset }
        });
      }
    }

    await store.saveCollection({
      ...run,
      idempotencyKey: "max-graph",
      summary: { ...run.summary, itemsProduced: 48, edgesProduced: 96 }
    }, maxItems, maxEdges);
    const loaded = await store.loadCollection(run.incidentId);
    expect(loaded.items).toHaveLength(48);
    expect(loaded.edges).toHaveLength(96);
  });
});
