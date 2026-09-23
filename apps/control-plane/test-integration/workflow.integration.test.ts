import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env, exports as workerExports } from "cloudflare:workers";
import { introspectWorkflowInstance } from "cloudflare:test";

import { GITHUB_ACTIONS_APP_ID } from "../src/github/source-router";
import { D1IncidentStore } from "../src/adapters/d1-incident-store";
import { D1IncidentAuthorizationPolicy } from "../src/adapters/d1-incident-authorization-policy";

const appId = Number(GITHUB_ACTIONS_APP_ID);
const repo = 4207;

type Introspector = Awaited<
  ReturnType<typeof introspectWorkflowInstance>
>;

const introspectors = new Map<string, Introspector>();

async function observe(id: string): Promise<Introspector> {
  const existing = introspectors.get(id);
  if (existing) return existing;

  const instance = await introspectWorkflowInstance(
    env.INCIDENT_WORKFLOW,
    id,
  );

  introspectors.set(id, instance);
  return instance;
}

async function finish(id: string): Promise<unknown> {
  const instance = await observe(id);
  await instance.waitForStatus("complete");
  return await instance.getOutput();
}

// Dispose only after all assertions and redeliveries have finished.
// Attempt every cleanup and report failures rather than swallowing them.
afterEach(async () => {
  const handles = [...introspectors.values()];
  introspectors.clear();

  const results = await Promise.allSettled(
    handles.map((instance) => instance.dispose()),
  );

  const failures = results.filter(
    (result): result is PromiseRejectedResult =>
      result.status === "rejected",
  );

  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((result) => result.reason),
      "Workflow introspector cleanup failed",
    );
  }
});

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM github_webhook_deliveries"),
    env.DB.prepare("DELETE FROM audit_events"),
    env.DB.prepare(`
      DELETE FROM incidents
      WHERE id NOT IN (
        SELECT incident_id FROM incident_supersessions
        UNION
        SELECT canonical_incident_id FROM incident_supersessions
      )
    `),
    env.DB.prepare("DELETE FROM trusted_check_providers"),
    env.DB.prepare(`
      INSERT INTO github_installations (
        external_id,
        account_external_id,
        account_login,
        account_type,
        repository_selection,
        permissions_json,
        updated_at
      )
      VALUES (
        '7', '1', 'test', 'Organization', 'selected',
        '{"actions":"read","checks":"read","contents":"read"}',
        '2026-01-01'
      )
      ON CONFLICT(external_id) DO UPDATE SET
        permissions_json = excluded.permissions_json,
        suspended_at = NULL
    `),
    env.DB.prepare(`
      UPDATE runtime_controls SET enabled = 1
      WHERE control_key = 'webhook_ingestion_enabled'
    `),
    env.DB.prepare(`
      UPDATE runtime_controls SET enabled = 0
      WHERE control_key = 'evidence_collection_enabled'
    `),
  ]);
});

function payload(
  event: string,
  runId: number,
  producer: number | null = appId,
  repositoryId = repo,
) {
  const base = {
    action: "completed",
    installation: { id: 7 },
    repository: {
      id: repositoryId,
      full_name: "test/repo",
    },
  };

  return event === "workflow_run"
    ? {
        ...base,
        workflow_run: {
          id: runId,
          conclusion: "failure",
          head_sha: "a".repeat(40),
          check_suite_id: 99,
        },
      }
    : {
        ...base,
        check_run: {
          id: runId,
          conclusion: "failure",
          head_sha: "a".repeat(40),
          check_suite: {
            id: 99,
            head_sha: "a".repeat(40),
          },
          ...(producer === null
            ? {}
            : {
                app: {
                  id: producer,
                  slug:
                    producer === appId
                      ? "github-actions"
                      : "external-ci",
                },
              }),
        },
      };
}

async function send(
  event: string,
  value: unknown,
  delivery = crypto.randomUUID(),
) {
  const body = JSON.stringify(value);

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.GITHUB_WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(body),
    ),
  );

  const response = await workerExports.default.fetch(
    "https://test.invalid/webhooks/github",
    {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "x-github-event": event,
        "x-github-delivery": delivery,
        "x-hub-signature-256":
          "sha256=" +
          Array.from(signature, (byte) =>
            byte.toString(16).padStart(2, "0"),
          ).join(""),
      },
    },
  );

  expect(response.status).toBeGreaterThanOrEqual(200);
  expect(response.status).toBeLessThan(300);

  return (await response.json()) as {
    disposition: string;
    incidentId: string | null;
    workflowId: string | null;
    duplicate?: boolean;
  };
}

// Scope counts to this suite's routing repository. Historical supersession
// fixtures use another repository and must remain preserved.
async function incidentCount() {
  const result = await env.DB.prepare(`
    SELECT COUNT(*) AS n
    FROM incidents i
    JOIN repositories r ON r.id = i.repository_id
    WHERE r.external_id = ?
  `)
    .bind(String(repo))
    .first<{ n: number }>();

  return result?.n ?? 0;
}

describe("deterministic source routing", () => {
  it.each(["check-first", "workflow-first", "concurrent"])(
    "creates one incident with %s and redeliveries",
    async (order) => {
      const run = payload("workflow_run", 100);
      const check = payload("check_run", 200);

      let results: Awaited<ReturnType<typeof send>>[];

      if (order === "concurrent") {
        results = await Promise.all([
          send("check_run", check),
          send("workflow_run", run),
          send("workflow_run", run),
          send("check_run", payload("check_run", 201)),
        ]);
      } else if (order === "check-first") {
        results = [
          await send("check_run", check),
          await send("workflow_run", run),
        ];
      } else {
        results = [
          await send("workflow_run", run),
          await send("check_run", check),
        ];
      }

      const canonical = results.find(
        (result) => result.disposition === "CANONICAL_TRIGGER",
      );

      expect(canonical?.incidentId).toBeTruthy();
      expect(canonical?.workflowId).toBeTruthy();

      const supporting = results.filter(
        (result) => result.disposition === "SUPPORTING_ONLY",
      );

      expect(supporting).toHaveLength(
        order === "concurrent" ? 2 : 1,
      );

      for (const result of supporting) {
        expect(result.incidentId).toBeNull();
        expect(result.workflowId).toBeNull();
      }

      for (const result of results.filter(
        (result) => result.disposition === "CANONICAL_TRIGGER",
      )) {
        expect(result.incidentId).toBe(canonical!.incidentId);
        expect(result.workflowId).toBe(canonical!.workflowId);
      }

      await finish(canonical!.workflowId!);

      // Keep the completed instance intact during redelivery.
      const again = await send("workflow_run", run);
      expect(again.incidentId).toBe(canonical!.incidentId);
      expect(again.workflowId).toBe(canonical!.workflowId);
      await finish(again.workflowId!);

      expect(await incidentCount()).toBe(1);

      const events = await env.DB.prepare(`
        SELECT COUNT(*) AS n FROM audit_events
        WHERE event_type = 'INCIDENT_CREATED'
      `).first<{ n: number }>();

      expect(events?.n).toBe(1);
    },
  );

  it("completes supporting deliveries without an incident and handles simultaneous same-ID delivery", async () => {
    const delivery = crypto.randomUUID();
    const check = payload("check_run", 202);

    const simultaneous = await Promise.all([
      send("check_run", check, delivery),
      send("check_run", check, delivery),
    ]);

    for (const result of simultaneous) {
      expect(result).toMatchObject({
        disposition: "SUPPORTING_ONLY",
        incidentId: null,
        workflowId: null,
      });
    }

    expect(await send("check_run", check, delivery)).toMatchObject({
      disposition: "SUPPORTING_ONLY",
      duplicate: true,
      incidentId: null,
      workflowId: null,
    });

    const row = await env.DB.prepare(`
      SELECT processed_at, incident_id, disposition
      FROM github_webhook_deliveries
      WHERE delivery_id = ?
    `)
      .bind(delivery)
      .first();

    expect(row).toMatchObject({
      processed_at: expect.any(String),
      incident_id: null,
      disposition: "SUPPORTING_ONLY",
    });

    expect(await incidentCount()).toBe(0);
  });

  it("requires repository-scoped approval for independent checks", async () => {
    expect(
      (await send("check_run", payload("check_run", 300, 900)))
        .disposition,
    ).toBe("PENDING_VERIFICATION");

    await env.DB.prepare(`
      INSERT INTO trusted_check_providers
      VALUES ('7', ?, '900', 1)
    `)
      .bind(String(repo))
      .run();

    const accepted = await send(
      "check_run",
      payload("check_run", 301, 900),
    );

    expect(accepted.disposition).toBe("INDEPENDENT_TRIGGER");
    expect(accepted.workflowId).toBeTruthy();
    await finish(accepted.workflowId!);

    expect(
      (
        await send(
          "check_run",
          payload("check_run", 302, 900, repo + 1),
        )
      ).disposition,
    ).toBe("PENDING_VERIFICATION");
  });

  it("holds unknown and inconsistent identities without creating incidents", async () => {
    expect(
      (await send("check_run", payload("check_run", 400, null)))
        .disposition,
    ).toBe("PENDING_VERIFICATION");

    const spoof = payload("check_run", 401, 900) as any;
    spoof.check_run.app.slug = "github-actions";

    expect((await send("check_run", spoof)).disposition).toBe(
      "PENDING_VERIFICATION",
    );

    expect((await send("check_run", null)).disposition).toBe(
      "REJECTED",
    );

    expect(await incidentCount()).toBe(0);
  });

  it("does not promote a completed pending delivery when provider policy later changes", async () => {
    const delivery = crypto.randomUUID();
    const check = payload("check_run", 420, 900);

    expect(
      (await send("check_run", check, delivery)).disposition,
    ).toBe("PENDING_VERIFICATION");

    await env.DB.prepare(`
      INSERT INTO trusted_check_providers
      VALUES ('7', ?, '900', 1)
    `)
      .bind(String(repo))
      .run();

    expect(await send("check_run", check, delivery)).toMatchObject({
      disposition: "PENDING_VERIFICATION",
      duplicate: true,
      incidentId: null,
      workflowId: null,
    });

    expect(await incidentCount()).toBe(0);
  });

  it("rejects suspended installations and never treats malformed identity as a trigger", async () => {
    const malformed = payload("check_run", 430) as any;
    malformed.check_run.app.id = "15368";

    expect((await send("check_run", malformed)).disposition).toBe(
      "PENDING_VERIFICATION",
    );

    await env.DB.prepare(`
      UPDATE github_installations
      SET suspended_at = '2026-01-01'
      WHERE external_id = '7'
    `).run();

    expect(
      (await send("workflow_run", payload("workflow_run", 431)))
        .disposition,
    ).toBe("REJECTED");

    expect(await incidentCount()).toBe(0);
  });

  it("keeps different workflows on one commit separate", async () => {
    const results = await Promise.all([
      send("workflow_run", payload("workflow_run", 501)),
      send("workflow_run", payload("workflow_run", 502)),
    ]);

    expect(results[0]!.incidentId).toBeTruthy();
    expect(results[1]!.incidentId).toBeTruthy();
    expect(results[0]!.incidentId).not.toBe(results[1]!.incidentId);

    expect(results[0]!.workflowId).toBeTruthy();
    expect(results[1]!.workflowId).toBeTruthy();
    expect(results[0]!.workflowId).not.toBe(results[1]!.workflowId);

    await Promise.all(
      results.map((result) => finish(result.workflowId!)),
    );

    expect(await incidentCount()).toBe(2);
  });

  it("preserves historical incidents and denies workflow execution after supersession", async () => {
    const store = new D1IncidentStore(env.DB);
    const suffix = crypto.randomUUID();

    const common = {
      provider: "github" as const,
      repositoryExternalId: "999",
      repositoryFullName: "test/repo",
      installationExternalId: "7",
      deliveryId: `historical-${suffix}`,
      headSha: "a".repeat(40),
      failureSummary: "failure",
    };

    const old = (
      await store.createOrGet(
        {
          ...common,
          triggerType: "GITHUB_CHECK_RUN",
          triggerExternalId: `9001-${suffix}`,
        },
        `old-${suffix}`,
      )
    ).incident;

    const canonical = (
      await store.createOrGet(
        {
          ...common,
          triggerType: "GITHUB_WORKFLOW_RUN",
          triggerExternalId: `9002-${suffix}`,
        },
        `canonical-${suffix}`,
      )
    ).incident;

    await env.DB.prepare(`
      INSERT INTO incident_supersessions (
        incident_id, canonical_incident_id, reason,
        recorded_at, recorded_by
      )
      VALUES (
        ?, ?, 'GITHUB_ACTIONS_CHECK_DUPLICATE',
        '2026-01-01', 'test-operator'
      )
    `)
      .bind(old.id, canonical.id)
      .run();

    expect(await store.isSuperseded(old.id)).toBe(true);

    expect(
      await new D1IncidentAuthorizationPolicy(env.DB).evaluate(old.id),
    ).toEqual({
      allowed: false,
      reason: "SUPERSEDED",
    });

    await expect(
      env.DB.prepare(`
        UPDATE incident_supersessions
        SET recorded_by = 'changed'
        WHERE incident_id = ?
      `)
        .bind(old.id)
        .run(),
    ).rejects.toThrow();

    const workflowId = `incident-${old.id}`;

    // Register observation before starting this short-lived workflow.
    const instance = await observe(workflowId);

    await env.INCIDENT_WORKFLOW.create({
      id: workflowId,
      params: { incidentId: old.id },
    });

    await instance.waitForStatus("complete");

    expect(await instance.getOutput()).toMatchObject({
      status: "SUPERSEDED",
    });

    expect((await store.getById(old.id))?.status).toBe("RECEIVED");
    expect(await store.getById(canonical.id)).not.toBeNull();

    // Cleanup happens in afterEach, after every assertion above.
  });
});