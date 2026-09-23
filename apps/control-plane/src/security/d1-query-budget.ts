import { EVIDENCE_LIMITS, MAX_EVIDENCE_PERSISTENCE_STATEMENTS } from "./resource-limits";

export const D1_MAX_BOUND_PARAMETERS = 100;
export const EVIDENCE_ITEM_COLUMNS = 17;
export const EVIDENCE_EDGE_COLUMNS = 11;

export const EVIDENCE_ITEM_CHUNK_SIZE = Math.floor(
  D1_MAX_BOUND_PARAMETERS / EVIDENCE_ITEM_COLUMNS
);
export const EVIDENCE_EDGE_CHUNK_SIZE = Math.floor(
  D1_MAX_BOUND_PARAMETERS / EVIDENCE_EDGE_COLUMNS
);

export function estimateEvidencePersistenceStatements(
  itemCount: number,
  edgeCount: number
): number {
  if (!Number.isInteger(itemCount) || itemCount < 0) throw new Error("Invalid item count");
  if (!Number.isInteger(edgeCount) || edgeCount < 0) throw new Error("Invalid edge count");

  // Two snapshot deletes + one collection-run upsert, followed by chunked item
  // and edge inserts.
  return 3
    + Math.ceil(itemCount / EVIDENCE_ITEM_CHUNK_SIZE)
    + Math.ceil(edgeCount / EVIDENCE_EDGE_CHUNK_SIZE);
}

export function assertEvidencePersistenceBudget(itemCount: number, edgeCount: number): void {
  if (itemCount > EVIDENCE_LIMITS.maxItems) {
    throw new Error(`Evidence item budget exceeded: ${itemCount}`);
  }
  if (edgeCount > EVIDENCE_LIMITS.maxEdges) {
    throw new Error(`Evidence edge budget exceeded: ${edgeCount}`);
  }

  const statements = estimateEvidencePersistenceStatements(itemCount, edgeCount);
  if (statements > MAX_EVIDENCE_PERSISTENCE_STATEMENTS) {
    throw new Error(`D1 evidence statement budget exceeded: ${statements}`);
  }
}
