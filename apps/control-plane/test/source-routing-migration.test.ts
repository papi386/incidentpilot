import { readFileSync } from "node:fs";

import { unstable_splitSqlQuery } from "wrangler";
import { describe, expect, it } from "vitest";

describe("source routing migration deployment parsing", () => {
  it("keeps the backfill, tables and complete triggers in separate Wrangler queries", () => {
    const sql = readFileSync(
      new URL(
        "../../../migrations/0007_source_routing.sql",
        import.meta.url,
      ),
      "utf8",
    );

    const queries = unstable_splitSqlQuery(sql)
      .map((query) => query.trim())
      .filter((query) => query.length > 0);

    expect(queries).toHaveLength(15);

    const alters = queries.filter((query) =>
      query.startsWith("ALTER TABLE"),
    );

    expect(alters).toHaveLength(8);

    const backfills = queries.filter((query) =>
      query.startsWith("UPDATE github_webhook_deliveries"),
    );

    expect(backfills).toHaveLength(2);

    const workflowBackfill = backfills.find((query) =>
      query.includes("event_name = 'workflow_run'"),
    );

    const nonWorkflowBackfill = backfills.find((query) =>
      query.includes("event_name <> 'workflow_run'"),
    );

    expect(workflowBackfill).toBeDefined();
    expect(nonWorkflowBackfill).toBeDefined();

    expect(workflowBackfill).toContain(
      "disposition = 'CANONICAL_TRIGGER'",
    );

    expect(nonWorkflowBackfill).toContain(
      "disposition = 'INDEPENDENT_TRIGGER'",
    );

    for (const backfill of backfills) {
      expect(backfill).toContain(
        "routing_reason = 'LEGACY_PRE_ROUTER'",
      );

      expect(backfill).toContain("routing_version = 0");
      expect(backfill).not.toMatch(/\bCASE\b/i);
    }

    const tables = queries.filter((query) =>
      query.startsWith("CREATE TABLE"),
    );

    expect(tables).toHaveLength(2);

    expect(
      tables.some((query) =>
        query.startsWith("CREATE TABLE trusted_check_providers"),
      ),
    ).toBe(true);

    expect(
      tables.some((query) =>
        query.startsWith("CREATE TABLE incident_supersessions"),
      ),
    ).toBe(true);

    const triggers = queries.filter((query) =>
      query.startsWith("CREATE TRIGGER"),
    );

    expect(triggers).toHaveLength(3);

    const validationTrigger = triggers.find((query) =>
      query.startsWith(
        "CREATE TRIGGER validate_incident_supersession",
      ),
    );

    const immutableUpdateTrigger = triggers.find((query) =>
      query.startsWith(
        "CREATE TRIGGER immutable_incident_supersession_update",
      ),
    );

    const immutableDeleteTrigger = triggers.find((query) =>
      query.startsWith(
        "CREATE TRIGGER immutable_incident_supersession_delete",
      ),
    );

    expect(validationTrigger).toBeDefined();
    expect(immutableUpdateTrigger).toBeDefined();
    expect(immutableDeleteTrigger).toBeDefined();

    for (const trigger of triggers) {
      expect(trigger).toMatch(/\bBEGIN\b/);
      expect(trigger).toMatch(/\bEND\s*;?\s*$/);
    }

    expect(validationTrigger).toContain(
      "Conflicting supersession relationship",
    );

    expect(validationTrigger).toContain(
      "Invalid supersession relationship",
    );

    expect(validationTrigger).toContain(
      "old.trigger_type = 'GITHUB_CHECK_RUN'",
    );

    expect(validationTrigger).toContain(
      "canonical.trigger_type = 'GITHUB_WORKFLOW_RUN'",
    );

    expect(validationTrigger).toContain(
      "old.head_sha = canonical.head_sha",
    );

    expect(validationTrigger).not.toMatch(/\bCASE\b/i);

    expect(validationTrigger).toContain("WHERE EXISTS");
    expect(validationTrigger).toContain("WHERE NOT EXISTS");

    expect(immutableUpdateTrigger).toContain(
      "Supersession records are immutable",
    );

    expect(immutableDeleteTrigger).toContain(
      "Supersession records are immutable",
    );
  });
});