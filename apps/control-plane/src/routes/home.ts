import type { Context } from "hono";
import type { AppBindings } from "../bindings";
import { D1AuthStore } from "../adapters/d1-auth-store";
import { resolveSessionUser } from "../auth/session";
import { renderHome } from "../ui/home";

function statusMessage(c: Context<{ Bindings: AppBindings }>): string | undefined {
  if (c.req.query("installed") === "1") {
    return "GitHub App installation verified and synchronized.";
  }
  if (c.req.query("login") === "1" && c.req.query("sync") === "retry") {
    return "Signed in successfully. Installation synchronization could not complete; use Refresh installations to retry.";
  }
  if (c.req.query("login") === "1") {
    return "Signed in with GitHub.";
  }
  const authError = c.req.query("auth_error");
  if (authError) return `GitHub authorization failed: ${authError}`;
  return undefined;
}

export async function homeRoute(c: Context<{ Bindings: AppBindings }>) {
  const store = new D1AuthStore(c.env.DB);
  const user = await resolveSessionUser(store, c.req.header("Cookie"));
  const installations = user ? await store.listUserInstallations(user.id) : [];

  return c.html(renderHome(user, installations, statusMessage(c)));
}
