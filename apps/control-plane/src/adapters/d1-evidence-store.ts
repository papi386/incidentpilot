import type {
  EvidenceCollectionRunInput,
  EvidenceDraft,
  EvidenceEdgeDraft,
  EvidenceStore,
  EvidenceKind,
  EvidenceSourceKind,
  EvidenceIntegrity,
  EvidenceContentClass,
  EvidenceSensitivity,
  EvidenceEdgeRelation,
  StoredEvidenceCollection
} from "@incidentpilot/domain";
import { EvidenceCipher } from "../security/evidence-crypto";
import {
  EVIDENCE_EDGE_CHUNK_SIZE,
  EVIDENCE_ITEM_CHUNK_SIZE,
  EVIDENCE_EDGE_COLUMNS,
  assertEvidencePersistenceBudget
} from "../security/d1-query-budget";
import { sha256Hex } from "../security/sha256";

function chunks<T>(items: readonly T[], size: number): T[][] {
  const output: T[][] = [];
  for (let i = 0; i < items.length; i += size) output.push(items.slice(i, i + size));
  return output;
}

async function stableId(prefix: string, value: string): Promise<string> {
  return `${prefix}_${(await sha256Hex(value)).slice(0, 40)}`;
}

type ItemRow = {
  id: string;
  incident_id: string;
  dedupe_key: string;
  kind: EvidenceKind;
  source_kind: EvidenceSourceKind;
  integrity: EvidenceIntegrity;
  content_class: EvidenceContentClass;
  sensitivity: EvidenceSensitivity;
  instruction_trust: "NEVER_INSTRUCTIONS";
  ciphertext_b64: string;
  nonce_b64: string;
  aad_version: 2;
  key_version: string;
  collected_at: string;
};

type EdgeRow = {
  id: string;
  incident_id: string;
  from_evidence_id: string;
  to_evidence_id: string;
  relation: EvidenceEdgeRelation;
  ciphertext_b64: string;
  nonce_b64: string;
  aad_version: 2;
  key_version: string;
  created_at: string;
};

export class D1EvidenceStore implements EvidenceStore {
  constructor(
    private readonly db: D1Database,
    private readonly cipher: EvidenceCipher
  ) {}

  async saveCollection(
    run: EvidenceCollectionRunInput,
    items: EvidenceDraft[],
    edges: EvidenceEdgeDraft[]
  ): Promise<void> {
    assertEvidencePersistenceBudget(items.length, edges.length);

    const itemIds = new Map<string, string>();
    const opaqueDedupeKeys = new Map<string, string>();
    for (const item of items) {
      const opaque = await this.cipher.opaqueIndex(`${run.incidentId}:${item.dedupeKey}`);
      opaqueDedupeKeys.set(item.dedupeKey, opaque);
      itemIds.set(item.dedupeKey, await stableId("ev", `${run.incidentId}:${opaque}`));
    }

    const encryptedItems = await Promise.all(items.map(async (item) => {
      const opaque = opaqueDedupeKeys.get(item.dedupeKey);
      if (!opaque) throw new Error("Opaque evidence key invariant failed");
      return {
        item,
        opaque,
        encrypted: await this.cipher.encryptItem(run.incidentId, opaque, item)
      };
    }));

    const statements: D1PreparedStatement[] = [];
    const runId = await stableId("evrun", `${run.incidentId}:${run.source}`);

    statements.push(
      this.db.prepare("DELETE FROM evidence_edges WHERE incident_id = ?").bind(run.incidentId),
      this.db.prepare("DELETE FROM evidence_items WHERE incident_id = ?").bind(run.incidentId)
    );

    statements.push(this.db.prepare(`
      INSERT INTO evidence_collection_runs (
        id, idempotency_key, incident_id, source, status, requests_used,
        downloaded_bytes, items_produced, edges_produced, truncated,
        error_codes_json, base_resolution, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(incident_id, source) DO UPDATE SET
        idempotency_key = excluded.idempotency_key,
        status = excluded.status,
        requests_used = excluded.requests_used,
        downloaded_bytes = excluded.downloaded_bytes,
        items_produced = excluded.items_produced,
        edges_produced = excluded.edges_produced,
        truncated = excluded.truncated,
        error_codes_json = excluded.error_codes_json,
        base_resolution = excluded.base_resolution,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at
    `).bind(
      runId, run.idempotencyKey, run.incidentId, run.source, run.summary.status,
      run.summary.requestsUsed, run.summary.downloadedBytes, run.summary.itemsProduced,
      run.summary.edgesProduced, run.summary.truncated ? 1 : 0,
      JSON.stringify(run.summary.errorCodes), run.summary.baseResolution,
      run.startedAt, run.completedAt
    ));

    for (const group of chunks(encryptedItems, EVIDENCE_ITEM_CHUNK_SIZE)) {
      const rowSql = group.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(",");
      const values: Array<string | number | null> = [];
      for (const { item, opaque, encrypted } of group) {
        const id = itemIds.get(item.dedupeKey);
        if (!id) throw new Error("Evidence ID invariant failed");
        values.push(
          id, run.incidentId, opaque, item.kind, item.sourceKind, null, null,
          item.integrity, item.contentClass, item.sensitivity, item.instructionTrust,
          encrypted.ciphertextB64, encrypted.nonceB64, encrypted.aadVersion,
          encrypted.keyVersion, JSON.stringify({ protected: true }), item.collectedAt
        );
      }
      statements.push(this.db.prepare(`
        INSERT INTO evidence_items (
          id, incident_id, dedupe_key, kind, source_kind, source_external_id,
          source_url, integrity, content_class, sensitivity, instruction_trust,
          ciphertext_b64, nonce_b64, aad_version, key_version, metadata_json, collected_at
        ) VALUES ${rowSql}
        ON CONFLICT(incident_id, dedupe_key) DO UPDATE SET
          source_external_id = excluded.source_external_id,
          source_url = excluded.source_url,
          integrity = excluded.integrity,
          content_class = excluded.content_class,
          sensitivity = excluded.sensitivity,
          instruction_trust = excluded.instruction_trust,
          ciphertext_b64 = excluded.ciphertext_b64,
          nonce_b64 = excluded.nonce_b64,
          aad_version = excluded.aad_version,
          key_version = excluded.key_version,
          metadata_json = excluded.metadata_json,
          collected_at = excluded.collected_at
      `).bind(...values));
    }

    const now = run.completedAt;
    for (const group of chunks(edges, EVIDENCE_EDGE_CHUNK_SIZE)) {
      const encryptedEdges: Array<{ edge: EvidenceEdgeDraft; edgeId: string; fromId: string; toId: string; encrypted: Awaited<ReturnType<EvidenceCipher["encryptEdgeMetadata"]>> }> = [];
      for (const edge of group) {
        const fromId = itemIds.get(edge.fromDedupeKey);
        const toId = itemIds.get(edge.toDedupeKey);
        if (!fromId || !toId) continue;
        const edgeId = await stableId("edge", `${run.incidentId}:${fromId}:${edge.relation}:${toId}`);
        encryptedEdges.push({
          edge,
          edgeId,
          fromId,
          toId,
          encrypted: await this.cipher.encryptEdgeMetadata(run.incidentId, edgeId, fromId, toId, edge, now)
        });
      }
      if (encryptedEdges.length === 0) continue;
      const values: Array<string | number | null> = [];
      for (const { edge, edgeId, fromId, toId, encrypted } of encryptedEdges) {
        values.push(
          edgeId, run.incidentId, fromId, toId, edge.relation,
          encrypted.ciphertextB64, encrypted.nonceB64, encrypted.aadVersion,
          encrypted.keyVersion, JSON.stringify({ protected: true }), now
        );
      }
      statements.push(this.db.prepare(`
        INSERT INTO evidence_edges (
          id, incident_id, from_evidence_id, to_evidence_id, relation,
          ciphertext_b64, nonce_b64, aad_version, key_version, metadata_json, created_at
        ) VALUES ${encryptedEdges.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(",")}
        ON CONFLICT(incident_id, from_evidence_id, to_evidence_id, relation) DO UPDATE SET
          ciphertext_b64 = excluded.ciphertext_b64,
          nonce_b64 = excluded.nonce_b64,
          aad_version = excluded.aad_version,
          key_version = excluded.key_version,
          metadata_json = excluded.metadata_json,
          created_at = excluded.created_at
      `).bind(...values));
    }

    await this.db.batch(statements);
  }

  async loadCollection(incidentId: string): Promise<StoredEvidenceCollection> {
    const itemResult = await this.db.prepare(`
      SELECT id, incident_id, dedupe_key, kind, source_kind, integrity,
             content_class, sensitivity, instruction_trust, ciphertext_b64,
             nonce_b64, aad_version, key_version, collected_at
      FROM evidence_items
      WHERE incident_id = ?
      ORDER BY collected_at, id
    `).bind(incidentId).all<ItemRow>();

    const idToDedupe = new Map<string, string>();
    const items: EvidenceDraft[] = [];
    for (const row of itemResult.results) {
      const item = await this.cipher.decryptItem({
        incidentId: row.incident_id,
        opaqueDedupeKey: row.dedupe_key,
        kind: row.kind,
        sourceKind: row.source_kind,
        integrity: row.integrity,
        contentClass: row.content_class,
        sensitivity: row.sensitivity,
        instructionTrust: row.instruction_trust,
        collectedAt: row.collected_at,
        ciphertextB64: row.ciphertext_b64,
        nonceB64: row.nonce_b64,
        aadVersion: row.aad_version,
        keyVersion: row.key_version
      });
      idToDedupe.set(row.id, item.dedupeKey);
      items.push(item);
    }

    const edgeResult = await this.db.prepare(`
      SELECT id, incident_id, from_evidence_id, to_evidence_id, relation,
             ciphertext_b64, nonce_b64, aad_version, key_version, created_at
      FROM evidence_edges
      WHERE incident_id = ?
      ORDER BY created_at, id
    `).bind(incidentId).all<EdgeRow>();

    const edges: EvidenceEdgeDraft[] = [];
    for (const row of edgeResult.results) {
      const fromDedupeKey = idToDedupe.get(row.from_evidence_id);
      const toDedupeKey = idToDedupe.get(row.to_evidence_id);
      if (!fromDedupeKey || !toDedupeKey) throw new Error("Evidence edge references missing item");
      const metadata = await this.cipher.decryptEdgeMetadata({
        incidentId: row.incident_id,
        edgeId: row.id,
        fromEvidenceId: row.from_evidence_id,
        toEvidenceId: row.to_evidence_id,
        relation: row.relation,
        createdAt: row.created_at,
        ciphertextB64: row.ciphertext_b64,
        nonceB64: row.nonce_b64,
        aadVersion: row.aad_version,
        keyVersion: row.key_version
      });
      edges.push({ fromDedupeKey, toDedupeKey, relation: row.relation, metadata });
    }

    return { items, edges };
  }
}
