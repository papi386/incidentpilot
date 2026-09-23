import { Hono } from "hono";
import type { AppBindings } from "./bindings";
import { D1AuthStore } from "./adapters/d1-auth-store";
import { resolveSessionUser } from "./auth/session";
import { githubWebhookRoute } from "./routes/github-webhook";
import {
  githubCallbackRoute,
  githubInstallRoute,
  githubLoginRoute,
  githubRefreshInstallationsRoute,
  logoutRoute
} from "./routes/auth";
import { homeRoute } from "./routes/home";
import { classifyD1ResourceExhaustion } from "./security/d1-errors";

export { IncidentWorkflow } from "./workflows/incident-workflow";

const app = new Hono<{ Bindings: AppBindings }>();

app.use("*", async (c, next) => {
  await next();

  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "no-referrer");
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  c.header(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' https://avatars.githubusercontent.com https://github.com data:; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
  );

  if (new URL(c.env.APP_BASE_URL).protocol === "https:") {
    c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
});

app.get("/", homeRoute);

app.get("/health", (c) =>
  c.json({
    status: "ok",
    service: "incidentpilot-control-plane",
    version: "0.3.3"
  })
);

app.get("/auth/github/login", githubLoginRoute);
app.get("/auth/github/callback", githubCallbackRoute);
app.post("/auth/logout", logoutRoute);
app.get("/github/install", githubInstallRoute);
app.get("/github/refresh", githubRefreshInstallationsRoute);

app.post("/webhooks/github", githubWebhookRoute);

app.get("/api/me", async (c) => {
  const store = new D1AuthStore(c.env.DB);
  const user = await resolveSessionUser(store, c.req.header("Cookie"));
  if (!user) return c.json({ authenticated: false }, 401);

  return c.json({
    authenticated: true,
    user,
    installations: await store.listUserInstallations(user.id)
  });
});

app.onError((error, c) => {
  const exhaustion = classifyD1ResourceExhaustion(error);
  if (exhaustion) {
    c.header("Retry-After", String(exhaustion.retryAfterSeconds));
    console.error(JSON.stringify({
      event: "d1_resource_exhausted",
      boundary: "http_request",
      path: new URL(c.req.url).pathname,
      method: c.req.method,
      resourceKind: exhaustion.kind
    }));
    return c.json({
      error: "resource exhausted",
      code: "D1_RESOURCE_EXHAUSTED",
      resource: exhaustion.kind
    }, 503);
  }

  // Keep production errors useful without logging OAuth codes, access tokens,
  // client secrets, request bodies, or stack traces.
  const safeMessage = error instanceof Error
    ? error.message
        .replace(/code=[^&\s]+/giu, "code=[REDACTED]")
        .replace(/access_token=[^&\s]+/giu, "access_token=[REDACTED]")
        .replace(/client_secret=[^&\s]+/giu, "client_secret=[REDACTED]")
    : "unknown error";

  console.error(JSON.stringify({
    event: "request_failed",
    path: new URL(c.req.url).pathname,
    method: c.req.method,
    errorName: error instanceof Error ? error.name : "UnknownError",
    errorMessage: safeMessage
  }));
  return c.json({ error: "internal server error" }, 500);
});

export default app;
