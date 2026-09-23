# IncidentPilot V1.2.3 Security Model

## Principle

Assume breach. We cannot guarantee prevention of unknown/zero-day exploits; we design so compromise of one layer does not automatically provide secrets, arbitrary execution, privileged repository writes and unrestricted egress together.

## Trust boundaries

1. Public webhook boundary: exact-byte HMAC before parsing; 1 MiB cap; event/content-type validation; delivery conflict ledger.
2. GitHub API boundary: short-lived installation tokens, single-repository scope, least read permissions, no persistence.
3. Evidence boundary: provider authenticity is not instruction authority. Every repository/runtime text item is `NEVER_INSTRUCTIONS`.
4. Persistence boundary: redaction first, AES-256-GCM second, authenticated AAD, no plaintext evidence column.
5. Orchestration boundary: legal state machine, durable/idempotent steps, bounded retries, `FAILED_SAFE`/`SECURITY_ABORTED`.
6. Future agent boundary: model and privileged-action controls default OFF. Models will never own raw credentials or unrestricted tools.

## Zero-day containment

- Minimize authority and credential lifetime.
- Keep control plane separate from future untrusted execution plane.
- Fail closed on missing controls/authorization/security metadata.
- Bound requests, bytes, evidence items, graph edges, D1 statements, time and retries.
- Treat D1 quota/capacity exhaustion as a non-retryable availability/security condition instead of amplifying it with retries.
- Allow emergency shutdown through D1 controls without adding a public admin endpoint.
- Preserve tamper-evident audit chaining.
- Treat detector output as telemetry, never as the sole security gate.
- Use dependency lockfiles/audit and Dependabot; future GitHub Actions must pin third-party actions to full commit SHAs.

## Prompt injection / context poisoning

README/code/log/diff/check output may contain attacker-written instructions. Authentication only establishes provenance. It never changes `instruction_trust`. Injection pattern detection is useful for observability but a false negative must remain safe.

## Redirect / SSRF defense

The GitHub API request uses `redirect: manual`. IncidentPilot validates the returned URL and performs a separate credential-free request. Only HTTPS, standard TLS port, no embedded credentials, no IP literals/local hosts, and GitHub Actions/Azure blob log domains are accepted. Redirect chaining is disabled.

## Encryption

`EVIDENCE_ENCRYPTION_KEY_B64` must decode to 32 random bytes. AES-GCM uses a fresh 96-bit nonce per evidence row. AAD binds ciphertext to incident/evidence security attributes. The key is a Cloudflare secret / local `.dev.vars` value and is never stored in D1.

Key rotation is versioned. Do not replace an active key without re-encrypting or expiring old evidence.

## Kill switches

`runtime_controls` defaults:
- webhook ingestion: ON
- evidence collection: ON
- model calls: OFF
- privileged actions: OFF

Missing rows fail closed. There is deliberately no unauthenticated HTTP endpoint for changing controls.

## D1 resource exhaustion / denial-of-service

Cloudflare D1 Free can stop serving reads or writes after daily limits are exhausted. V1.2.3 treats the documented row-read, row-write, account-storage and database-capacity errors as `RESOURCE_EXHAUSTED`, not a normal transient failure. Workflow steps throw `NonRetryableError`; exactly one best-effort direct fail-safe write is attempted, and the Workflow can still return the fail-safe reason when D1 is unable to store it.

The evidence graph is capped at 48 nodes / 96 edges and its persistence query plan is budgeted before encryption/write. Webhook replay rows are retained for four days and pruned in bounded indexed batches. These limits are both cost controls and denial-of-service controls.

## Supply chain

- npm package manager version is pinned in `packageManager`.
- package-lock is expected from `npm install`; commit it before production deployment.
- `.npmrc` keeps lockfiles enabled and new direct saves exact.
- Dependabot monitors both npm and GitHub Actions ecosystems.
- `.github/workflows/codeql.yml` scans `actions` plus `javascript-typescript`.
- `scripts/Check-WorkflowSecurity.mjs` independently blocks mutable external action refs, `pull_request_target`, `permissions: write-all`, workflow use of `author_association`, `secrets: inherit`, and unpinned Docker actions; it scans workflows and local composite-action YAML.
- Run `npm audit --audit-level=high` and review advisories; do not auto-apply breaking upgrades without tests.
- Workflows must follow GitHub secure-use guidance and pin external/reusable actions to immutable full commit SHAs.
- Branch protection/ruleset requirements are documented in `SECURITY-RELEASE-GATE.md`.

## V1.3 execution security gate

Recent autonomous-agent advisories reinforce that URL validation, path normalization and prompt rules alone are insufficient. V1.2.3 retains the removal of the unused free-form `command: string` future execution contract: the provider-neutral port now accepts only typed verification capabilities with argv-style data and `networkPolicy: DENY_ALL`. Before IncidentPilot gains arbitrary fetch/filesystem/shell/child-agent execution, `V1.3-EXECUTION-SECURITY.md` is a mandatory acceptance specification. It requires IP-pinned SSRF/DNS-rebinding defenses, redirect revalidation, canonical/post-open filesystem confinement, symlink escape resistance, scrubbed environments, shell-off-by-default, child-agent privilege non-inheritance, independent runtime policy, and adversarial tests.

## Non-claims

V1.2 is not claimed to be zero-day-proof, SOC 2 certified, GDPR compliant, or a secure arbitrary-code sandbox. GitHub-hosted Actions may later serve as a free verification backend, but the domain keeps an `ExecutionBackend` port so high-risk execution can move to stronger isolation.

## V1.2.2 independent-review fixes

V1.2.2 treats runtime controls as live policy, not cached authorization: evidence collection re-reads the control inside each retry attempt before credentials are minted. OAuth initiation has bounded application admission and expiry cleanup, with deployment-edge rate limiting still required against distributed abuse. GitHub outbound deadlines cover body streaming. Unsafe redirects are local permanent security failures rather than transient 5xx failures. Repository-derived filenames, source URLs and metadata are protected inside AES-GCM ciphertext; D1 stores keyed opaque evidence indexes rather than raw paths. Installation synchronization uses generation guards so stale concurrent refreshes cannot delete newer associations.


## V1.2.3 persistence and OAuth recovery hardening

V1.2.3 changes evidence encryption to AAD v2 so decryption depends only on fields persisted in the database envelope, never on plaintext values available only inside ciphertext. The original dedupe key, source identifiers/URLs, evidence metadata and content remain encrypted. Item lookup uses keyed opaque HMAC indexes. Edge metadata is encrypted separately and can be reconstructed on graph reload. `D1EvidenceStore.loadCollection()` is the persistence-level read path and is covered by a real D1 save/discard/reload/decrypt integration test.

OAuth consumption uses atomic `UPDATE ... RETURNING`. Active-flow capacity admission and insertion use one conditional `INSERT ... SELECT ... RETURNING` statement after bounded cleanup. The local burst key excludes `User-Agent` and uses `CF-Connecting-IP`; deployment-edge rate limiting remains mandatory for distributed abuse.

The workflow security checker parses semantic YAML, resolves aliases with bounded expansion, recursively inspects values, and includes adversarial fixtures for alias/mutable-action and `author_association` expression bypasses. CodeQL remains an independent layer rather than a substitute for the local policy.

Cloudflare-native integration tests now exercise D1 migrations/adapters and Worker HTTP boundaries. They do not yet constitute a complete durable-Workflow fault-injection harness; that remains an explicit acceptance item before higher-autonomy releases.
