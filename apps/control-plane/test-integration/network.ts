import { setupNetwork } from "@msw/cloudflare";

/*
 * Shared outbound-network interceptor for Workers integration tests.
 *
 * This runs inside the Workers Vitest runtime and allows us to exercise
 * IncidentPilot's REAL HTTP client code without making real external calls.
 *
 * Individual tests register only the handlers they need with network.use().
 *
 * setup.ts resets handlers after each test so one test cannot accidentally
 * influence another.
 */
export const network = setupNetwork();
