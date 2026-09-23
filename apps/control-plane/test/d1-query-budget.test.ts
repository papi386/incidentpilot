import { describe, expect, it } from "vitest";
import {
  assertEvidencePersistenceBudget,
  estimateEvidencePersistenceStatements
} from "../src/security/d1-query-budget";
import {
  EVIDENCE_LIMITS,
  MAX_EVIDENCE_PERSISTENCE_STATEMENTS
} from "../src/security/resource-limits";

describe("D1 evidence query budget", () => {
  it("keeps a maximum-sized evidence snapshot below the reserved statement ceiling", () => {
    const statements = estimateEvidencePersistenceStatements(
      EVIDENCE_LIMITS.maxItems,
      EVIDENCE_LIMITS.maxEdges
    );
    expect(statements).toBeLessThanOrEqual(MAX_EVIDENCE_PERSISTENCE_STATEMENTS);
    expect(statements).toBeLessThan(25);
  });

  it("rejects evidence graphs above the item or edge cap", () => {
    expect(() => assertEvidencePersistenceBudget(EVIDENCE_LIMITS.maxItems + 1, 0)).toThrow(/item budget/i);
    expect(() => assertEvidencePersistenceBudget(0, EVIDENCE_LIMITS.maxEdges + 1)).toThrow(/edge budget/i);
  });
});
