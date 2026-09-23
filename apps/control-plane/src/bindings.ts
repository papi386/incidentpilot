// Wrangler generates the authoritative runtime Env type from wrangler.jsonc.
// This narrow shape documents only what handwritten V1 code consumes.
export interface AppBindings {
  DB: D1Database;
  INCIDENT_WORKFLOW: Workflow;

  // Secrets: local .dev.vars / production Cloudflare Secrets.
  GITHUB_WEBHOOK_SECRET: string;
  GITHUB_APP_CLIENT_SECRET: string;
  GITHUB_APP_PRIVATE_KEY_B64: string;
  EVIDENCE_ENCRYPTION_KEY_B64: string;

  // Non-secret runtime configuration from wrangler.jsonc.
  GITHUB_APP_CLIENT_ID: string;
  GITHUB_APP_SLUG: string;
  APP_BASE_URL: string;
  EVIDENCE_ENCRYPTION_KEY_VERSION: string;
}
