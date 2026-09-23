import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { OAuthFlow } from "@incidentpilot/domain";
import { D1AuthStore } from "../src/adapters/d1-auth-store";

function flow(id: string): OAuthFlow {
  return {
    stateHash: `state-${id}`,
    browserBindingHash: `browser-${id}`,
    purpose: "LOGIN",
    createdAt: "2026-09-11T12:00:00.000Z",
    expiresAt: "2026-09-11T12:10:00.000Z"
  };
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM user_github_installations"),
    env.DB.prepare("DELETE FROM github_installations"),
    env.DB.prepare("DELETE FROM github_installation_sync_state"),
    env.DB.prepare("DELETE FROM oauth_flows"),
    env.DB.prepare("DELETE FROM sessions"),
    env.DB.prepare("DELETE FROM users")
  ]);
});

describe("D1 OAuth concurrency invariants", () => {
  it("enforces capacity atomically under concurrent admissions", async () => {
    const store = new D1AuthStore(env.DB);
    const [a, b] = await Promise.all([
      store.createOAuthFlowWithinCapacity(flow("a"), "2026-09-11T12:00:00.000Z", 1),
      store.createOAuthFlowWithinCapacity(flow("b"), "2026-09-11T12:00:00.000Z", 1)
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    const row = await env.DB.prepare("SELECT COUNT(*) AS c FROM oauth_flows WHERE consumed_at IS NULL").first<{ c: number }>();
    expect(Number(row?.c)).toBe(1);
  });

  it("atomically consumes and returns a flow even while cleanup runs", async () => {
    const store = new D1AuthStore(env.DB);
    await store.createOAuthFlow(flow("consume"));

    const consume = store.consumeOAuthFlow("state-consume", "browser-consume", "2026-09-11T12:01:00.000Z");
    const cleanup = store.createOAuthFlowWithinCapacity(flow("new"), "2026-09-11T12:01:00.000Z", 10, 25);
    const [consumed] = await Promise.all([consume, cleanup]);

    expect(consumed).toMatchObject({ stateHash: "state-consume", browserBindingHash: "browser-consume" });
  });
});
