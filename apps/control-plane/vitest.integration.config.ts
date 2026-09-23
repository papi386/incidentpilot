import { generateKeyPairSync } from "node:crypto";

import path from "node:path";

import { fileURLToPath } from "node:url";

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";

import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));

/*
 * Generate an ephemeral RSA private key solely for integration tests.
 *
 * This is:
 *
 * - NOT a GitHub credential
 * - NOT persisted
 * - NOT packaged into production
 * - regenerated whenever this Vitest configuration starts
 *
 * GitHubAppTokenBroker still performs its real RS256 signing logic.
 */
const { privateKey: integrationPrivateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,

  publicExponent: 0x10001,

  publicKeyEncoding: {
    type: "spki",
    format: "der",
  },

  privateKeyEncoding: {
    type: "pkcs8",
    format: "der",
  },
});

const integrationPrivateKeyB64 = integrationPrivateKey.toString("base64");

/*
 * Deterministic AES key used ONLY by integration tests.
 */
const integrationEvidenceKeyB64 = btoa(
  String.fromCharCode(
    ...Array.from(
      {
        length: 32,
      },
      (_, index) => index + 1,
    ),
  ),
);

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(
        path.resolve(here, "../../migrations"),
      );

      return {
        wrangler: {
          configPath: path.resolve(here, "wrangler.jsonc"),
        },

        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,

            /*
             * All values below are integration-test-only values.
             */
            GITHUB_WEBHOOK_SECRET: "integration-webhook-secret",

            GITHUB_APP_CLIENT_ID: "Iv1.incidentpilot-integration",

            GITHUB_APP_CLIENT_SECRET: "integration-client-secret",

            GITHUB_APP_PRIVATE_KEY_B64: integrationPrivateKeyB64,

            EVIDENCE_ENCRYPTION_KEY_B64: integrationEvidenceKeyB64,

            EVIDENCE_ENCRYPTION_KEY_VERSION: "integration-v1",
          },
        },
      };
    }),
  ],

  test: {
    include: ["test-integration/**/*.test.ts"],

    setupFiles: ["./test-integration/setup.ts"],

    testTimeout: 15_000,
  },
});
