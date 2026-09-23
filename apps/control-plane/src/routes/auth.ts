import type { Context } from "hono";
import type { OAuthFlowPurpose } from "@incidentpilot/domain";
import type { AppBindings } from "../bindings";
import { D1AuthStore } from "../adapters/d1-auth-store";
import {
  buildExpiredOAuthBindingCookie,
  buildOAuthBindingCookie,
  readOAuthBindingCookie
} from "../auth/oauth-binding-cookie";
import { randomUrlSafeToken } from "../auth/random-token";
import { buildExpiredSessionCookie } from "../auth/session-cookie";
import {
  createSession,
  resolveSessionUser,
  revokeSession
} from "../auth/session";
import { GitHubIdentityProvider } from "../github/github-identity-provider";
import { sha256Hex } from "../security/sha256";
import { allowOAuthAttempt, oauthAdmissionKey } from "../security/oauth-admission";

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

function callbackUrl(env: AppBindings): string {
  return new URL("/auth/github/callback", env.APP_BASE_URL).toString();
}

function secureCookies(env: AppBindings): boolean {
  return new URL(env.APP_BASE_URL).protocol === "https:";
}

function provider(env: AppBindings): GitHubIdentityProvider {
  return new GitHubIdentityProvider(
    env.GITHUB_APP_CLIENT_ID,
    env.GITHUB_APP_CLIENT_SECRET
  );
}

function noStore(c: Context<{ Bindings: AppBindings }>): void {
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
}

async function createAdmittedOAuthFlow(
  c: Context<{ Bindings: AppBindings }>,
  store: D1AuthStore,
  purpose: OAuthFlowPurpose,
  userId?: string
): Promise<{ flow?: { state: string; browserBinding: string }; response?: Response }> {
  // Cloudflare sets CF-Connecting-IP in production. User-Agent is intentionally
  // excluded because it is attacker-controlled and would let one IP mint a new
  // local rate-limit bucket simply by rotating headers.
  const key = oauthAdmissionKey(c.req.header("CF-Connecting-IP"));
  if (!allowOAuthAttempt(key)) {
    c.header("Retry-After", "60");
    return { response: c.json({ error: "too many OAuth attempts" }, 429) };
  }

  const state = randomUrlSafeToken(32);
  const browserBinding = randomUrlSafeToken(32);
  const now = new Date();
  const createdAt = now.toISOString();
  const flow = {
    stateHash: await sha256Hex(state),
    browserBindingHash: await sha256Hex(browserBinding),
    purpose,
    ...(userId ? { userId } : {}),
    createdAt,
    expiresAt: new Date(now.getTime() + OAUTH_STATE_TTL_MS).toISOString()
  };

  const admitted = await store.createOAuthFlowWithinCapacity(flow, createdAt);
  if (!admitted) {
    c.header("Retry-After", "60");
    return { response: c.json({ error: "OAuth flow capacity reached; retry later" }, 503) };
  }
  return { flow: { state, browserBinding } };
}

export async function githubLoginRoute(c: Context<{ Bindings: AppBindings }>) {
  noStore(c);
  const store = new D1AuthStore(c.env.DB);
  const admitted = await createAdmittedOAuthFlow(c, store, "LOGIN");
  if (admitted.response) return admitted.response;
  if (!admitted.flow) throw new Error("OAuth admission invariant failed");
  const flow = admitted.flow;
  c.header(
    "Set-Cookie",
    buildOAuthBindingCookie(flow.browserBinding, secureCookies(c.env))
  );
  return c.redirect(provider(c.env).authorizationUrl(flow.state, callbackUrl(c.env)), 302);
}

export async function githubInstallRoute(c: Context<{ Bindings: AppBindings }>) {
  noStore(c);
  const store = new D1AuthStore(c.env.DB);
  const user = await resolveSessionUser(store, c.req.header("Cookie"));
  if (!user) return c.redirect("/auth/github/login", 302);

  const admitted = await createAdmittedOAuthFlow(c, store, "INSTALL", user.id);
  if (admitted.response) return admitted.response;
  if (!admitted.flow) throw new Error("OAuth admission invariant failed");
  const flow = admitted.flow;
  c.header(
    "Set-Cookie",
    buildOAuthBindingCookie(flow.browserBinding, secureCookies(c.env))
  );

  const url = new URL(`https://github.com/apps/${encodeURIComponent(c.env.GITHUB_APP_SLUG)}/installations/new`);
  url.searchParams.set("state", flow.state);
  return c.redirect(url.toString(), 302);
}

export async function githubRefreshInstallationsRoute(
  c: Context<{ Bindings: AppBindings }>
) {
  noStore(c);
  const store = new D1AuthStore(c.env.DB);
  const user = await resolveSessionUser(store, c.req.header("Cookie"));
  if (!user) return c.redirect("/auth/github/login", 302);

  const admitted = await createAdmittedOAuthFlow(c, store, "INSTALL", user.id);
  if (admitted.response) return admitted.response;
  if (!admitted.flow) throw new Error("OAuth admission invariant failed");
  const flow = admitted.flow;
  c.header(
    "Set-Cookie",
    buildOAuthBindingCookie(flow.browserBinding, secureCookies(c.env))
  );
  return c.redirect(provider(c.env).authorizationUrl(flow.state, callbackUrl(c.env)), 302);
}

export async function githubCallbackRoute(c: Context<{ Bindings: AppBindings }>) {
  noStore(c);
  const secure = secureCookies(c.env);
  const error = c.req.query("error");
  if (error) {
    c.header("Set-Cookie", buildExpiredOAuthBindingCookie(secure));
    return c.redirect(`/?auth_error=${encodeURIComponent(error)}`, 302);
  }

  const code = c.req.query("code");
  const state = c.req.query("state");
  const browserBinding = readOAuthBindingCookie(c.req.header("Cookie"));
  if (!code || !state || !browserBinding) {
    return c.json({ error: "missing OAuth code, state, or browser binding" }, 400);
  }

  const store = new D1AuthStore(c.env.DB);
  const flow = await store.consumeOAuthFlow(
    await sha256Hex(state),
    await sha256Hex(browserBinding),
    new Date().toISOString()
  );

  c.header("Set-Cookie", buildExpiredOAuthBindingCookie(secure));

  if (!flow) {
    return c.json({ error: "invalid, expired, already-used, or browser-mismatched OAuth state" }, 400);
  }

  const github = provider(c.env);
  const auth = await github.exchangeCode(code, callbackUrl(c.env));

  if (flow.purpose === "LOGIN") {
    const user = await store.upsertUser(auth.identity);
    let synced = true;

    try {
      const syncStartedAt = new Date().toISOString();
      const generation = await store.beginInstallationRefresh(user.id, syncStartedAt);
      const installations = await github.listInstallations(auth.accessToken);
      await store.replaceUserInstallations(user.id, installations, new Date().toISOString(), generation);
    } catch {
      // Login identity is already verified. Installation sync can be retried separately.
      synced = false;
    }

    const session = await createSession(store, user.id, secure);
    c.header("Set-Cookie", session.cookie, { append: true });
    return c.redirect(synced ? "/?login=1" : "/?login=1&sync=retry", 302);
  }

  const sessionUser = await resolveSessionUser(store, c.req.header("Cookie"));
  if (!sessionUser || !flow.userId || sessionUser.id !== flow.userId) {
    return c.json({ error: "installation flow is not bound to this signed-in user" }, 403);
  }

  // Prevent a user from starting the flow as one GitHub identity and completing it as another.
  if (sessionUser.externalUserId !== auth.identity.externalUserId) {
    return c.json({ error: "GitHub identity changed during installation authorization" }, 403);
  }

  const syncStartedAt = new Date().toISOString();
  const generation = await store.beginInstallationRefresh(sessionUser.id, syncStartedAt);
  const installations = await github.listInstallations(auth.accessToken);
  await store.replaceUserInstallations(
    sessionUser.id,
    installations,
    new Date().toISOString(),
    generation
  );

  return c.redirect("/?installed=1", 302);
}

export async function logoutRoute(c: Context<{ Bindings: AppBindings }>) {
  noStore(c);
  const store = new D1AuthStore(c.env.DB);
  await revokeSession(store, c.req.header("Cookie"));
  c.header("Set-Cookie", buildExpiredSessionCookie(secureCookies(c.env)));
  return c.redirect("/", 303);
}
