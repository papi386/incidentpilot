import { beforeEach, describe, expect, it } from "vitest";
import { env, exports as workerExports } from "cloudflare:workers";
import { sha256Hex } from "../src/security/sha256";

async function hmac(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.GITHUB_WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return `sha256=${Array.from(signature, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM github_webhook_deliveries"),
    env.DB.prepare("DELETE FROM audit_events"),
    env.DB.prepare("DELETE FROM incidents"),
    env.DB.prepare("DELETE FROM repositories"),
    env.DB.prepare("DELETE FROM oauth_flows"),
    env.DB.prepare("DELETE FROM sessions"),
    env.DB.prepare("DELETE FROM users"),
    env.DB.prepare("UPDATE runtime_controls SET enabled = 1 WHERE control_key IN ('webhook_ingestion_enabled','evidence_collection_enabled')"),
    env.DB.prepare("UPDATE runtime_controls SET enabled = 0 WHERE control_key IN ('model_calls_enabled','privileged_actions_enabled')")
  ]);
});

describe("HTTP security boundaries", () => {
  it("rejects invalid webhook signatures before creating delivery state", async () => {
    const response = await workerExports.default.fetch("https://example.test/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "workflow_run",
        "x-github-delivery": "bad-sig",
        "x-hub-signature-256": "sha256=" + "0".repeat(64)
      },
      body: "{}"
    });
    expect(response.status).toBe(401);
    const row = await env.DB.prepare("SELECT COUNT(*) AS c FROM github_webhook_deliveries").first<{ c: number }>();
    expect(Number(row?.c)).toBe(0);
  });

  it("rejects a reused delivery id with different authenticated content", async () => {
    const bodyA = JSON.stringify({ action: "completed", repository: { id: 1, full_name: "a/b" }, workflow_run: { id: 1, conclusion: "success" } });
    const bodyB = JSON.stringify({ action: "completed", repository: { id: 1, full_name: "a/b" }, workflow_run: { id: 1, conclusion: "neutral" } });

    const send = async (body: string) => workerExports.default.fetch("https://example.test/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "workflow_run",
        "x-github-delivery": "same-delivery",
        "x-hub-signature-256": await hmac(body)
      },
      body
    });

    expect((await send(bodyA)).status).toBe(202);
    expect((await send(bodyB)).status).toBe(409);
  });

  it("rejects OAuth callback state without the browser-binding cookie before provider exchange", async () => {
    const response = await workerExports.default.fetch("https://example.test/auth/github/callback?code=x&state=y");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("browser binding") });
  });

  it("rejects a correctly hashed but expired session", async () => {
    const token = "known-expired-session-token";
    const now = Date.now();
    await env.DB.prepare(`INSERT INTO users (id, identity_provider, external_user_id, username, created_at, updated_at) VALUES ('u1','github','1','alice',?,?)`)
      .bind(new Date(now - 3_600_000).toISOString(), new Date(now - 3_600_000).toISOString()).run();
    await env.DB.prepare(`INSERT INTO sessions (id, token_hash, user_id, created_at, expires_at) VALUES ('s1', ?, 'u1', ?, ?)`)
      .bind(await sha256Hex(token), new Date(now - 3_600_000).toISOString(), new Date(now - 1_000).toISOString()).run();

    const response = await workerExports.default.fetch("https://example.test/api/me", {
      headers: { cookie: `incidentpilot_session=${encodeURIComponent(token)}` }
    });
    expect(response.status).toBe(401);
  });

  it("revokes an active session on logout", async () => {
    const token = "known-active-session-token";
    const now = Date.now();
    await env.DB.prepare(`INSERT INTO users (id, identity_provider, external_user_id, username, created_at, updated_at) VALUES ('u2','github','2','bob',?,?)`)
      .bind(new Date(now - 1_000).toISOString(), new Date(now - 1_000).toISOString()).run();
    await env.DB.prepare(`INSERT INTO sessions (id, token_hash, user_id, created_at, expires_at) VALUES ('s2', ?, 'u2', ?, ?)`)
      .bind(await sha256Hex(token), new Date(now - 1_000).toISOString(), new Date(now + 3_600_000).toISOString()).run();

    const before = await workerExports.default.fetch("https://example.test/api/me", {
      headers: { cookie: `incidentpilot_session=${encodeURIComponent(token)}` }
    });
    expect(before.status).toBe(200);

    const logout = await workerExports.default.fetch("https://example.test/auth/logout", {
      method: "POST",
      headers: { cookie: `incidentpilot_session=${encodeURIComponent(token)}` },
      redirect: "manual"
    });
    expect(logout.status).toBe(303);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");

    const row = await env.DB.prepare("SELECT COUNT(*) AS c FROM sessions WHERE token_hash = ?")
      .bind(await sha256Hex(token)).first<{ c: number }>();
    expect(Number(row?.c)).toBe(0);

    const after = await workerExports.default.fetch("https://example.test/api/me", {
      headers: { cookie: `incidentpilot_session=${encodeURIComponent(token)}` }
    });
    expect(after.status).toBe(401);
  });

  it("rejects an OAuth state bound to a different browser before provider exchange", async () => {
    const state = "known-oauth-state";
    const expectedBinding = "browser-a";
    const suppliedBinding = "browser-b";
    const now = Date.now();
    await env.DB.prepare(`
      INSERT INTO oauth_flows (state_hash, browser_binding_hash, purpose, user_id, created_at, expires_at, consumed_at)
      VALUES (?, ?, 'LOGIN', NULL, ?, ?, NULL)
    `).bind(
      await sha256Hex(state),
      await sha256Hex(expectedBinding),
      new Date(now - 1_000).toISOString(),
      new Date(now + 60_000).toISOString()
    ).run();

    const response = await workerExports.default.fetch(
      `https://example.test/auth/github/callback?code=must-not-be-exchanged&state=${encodeURIComponent(state)}`,
      { headers: { cookie: `incidentpilot_oauth_binding=${encodeURIComponent(suppliedBinding)}` } }
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("browser-mismatched") });
  });

  it("rejects an already-consumed OAuth state replay before provider exchange", async () => {
    const state = "replayed-oauth-state";
    const binding = "replayed-browser-binding";
    const now = Date.now();
    await env.DB.prepare(`
      INSERT INTO oauth_flows (state_hash, browser_binding_hash, purpose, user_id, created_at, expires_at, consumed_at)
      VALUES (?, ?, 'LOGIN', NULL, ?, ?, ?)
    `).bind(
      await sha256Hex(state),
      await sha256Hex(binding),
      new Date(now - 1_000).toISOString(),
      new Date(now + 60_000).toISOString(),
      new Date(now - 500).toISOString()
    ).run();

    const response = await workerExports.default.fetch(
      `https://example.test/auth/github/callback?code=must-not-be-exchanged&state=${encodeURIComponent(state)}`,
      { headers: { cookie: `incidentpilot_oauth_binding=${encodeURIComponent(binding)}` } }
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("already-used") });
  });

  it("rejects an expired OAuth state before provider exchange", async () => {
    const state = "expired-oauth-state";
    const binding = "expired-browser-binding";
    const now = Date.now();
    await env.DB.prepare(`
      INSERT INTO oauth_flows (state_hash, browser_binding_hash, purpose, user_id, created_at, expires_at, consumed_at)
      VALUES (?, ?, 'LOGIN', NULL, ?, ?, NULL)
    `).bind(
      await sha256Hex(state),
      await sha256Hex(binding),
      new Date(now - 120_000).toISOString(),
      new Date(now - 60_000).toISOString()
    ).run();

    const response = await workerExports.default.fetch(
      `https://example.test/auth/github/callback?code=must-not-be-exchanged&state=${encodeURIComponent(state)}`,
      { headers: { cookie: `incidentpilot_oauth_binding=${encodeURIComponent(binding)}` } }
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("expired") });
  });
});
