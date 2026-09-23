# IncidentPilot V1.2.3 + V1.3 Evaluation File Guide

This guide explains the V1.2.x Evidence Engine and its V1.2.3 recovery/concurrency hardening.

## Domain

- `packages/domain/src/evidence.ts` — provider-neutral evidence kinds, provenance/trust/sensitivity vocabulary, graph edges and collection summary. External text can only be `NEVER_INSTRUCTIONS`.
- `packages/domain/src/evidence-service.ts` — coordinates context lookup, collection, persistence and idempotent audit logging.
- `packages/domain/src/ports.ts` — adds EvidenceSource/Store/Context ports while keeping Cloudflare/GitHub details outside domain logic. V1.2.3 also hardens the unused future `ExecutionBackend` contract: no free-form shell command string; only typed verification capability + argv data with `DENY_ALL` network policy.
- `packages/domain/src/state-machine.ts` — allows security aborts during triage/context building while retaining explicit legal transitions.
- `packages/domain/src/diagnosis.ts` — strict read-only diagnosis contract, bounded hypotheses/checks and evidence-reference validation.
- `packages/domain/src/investigator.ts` — evidence-only investigator input, deterministic insufficient-evidence abstention and structured response parsing; exposes no tools or execution.
- `packages/domain/src/model-gate.ts` — fail-closed provider wrapper that rechecks model-call authorization on every request.

## V1.3 evaluation scaffold

- `packages/evals/src/cases/catalog.ts` — 40-case correctness, ambiguity, insufficiency, conflict and adversarial corpus with observable injection canaries.
- `packages/evals/src/runner.ts` / `scoring.ts` — evaluation orchestration, security checks, quality metrics and confidence-calibration measurements.
- `packages/evals/src/providers/scripted-provider.ts` — deterministic harness self-test only; never a model-performance result.
- `packages/evals/src/providers/openai-compatible-provider.ts` — bounded, redirect-rejecting, JSON-only adapter used only by explicitly authorized live evaluations.
- `packages/evals/src/baseline.ts` / `thresholds.json` — reviewed real-model baseline comparison and explicit regression policy.
- `packages/evals/src/report.ts` — console/JSON/Markdown reporting that omits free-form model output from persisted artifacts.
- `.github/workflows/live-model-evals.yml` — manual-only, read-only live corpus run with hard security gates.
- `docs/V1.3-EVALUATION-HARNESS.md` — operator guide, non-claims, metrics and limitations.

## GitHub collection

- `src/github/github-app-auth.ts` — signs GitHub App JWTs and mints one-repository, read-only installation tokens. Token responses are size-bounded and rate-limit guidance is preserved.
- `src/github/github-api.ts` — bounded API reads, timeout handling, one-time token refresh on 401, rate-limit classification, and credential-stripped/allowlisted log redirects.
- `src/evidence/github-evidence-source.ts` — bounded collector for run/check metadata, failed jobs, logs, commits, changed files and patches; derives tests/errors/stack frames and graph edges.
- `src/evidence/redaction.ts` — removes common credential/secret patterns before storage.
- `src/evidence/injection-signals.ts` — telemetry-only detector for suspicious instruction-like content. It never upgrades/downgrades trust.
- `src/evidence/log-excerpt.ts` — reduces large logs to relevant bounded excerpts.
- `src/evidence/failure-signals.ts` — deterministic failure-signal extraction.

## Security boundaries

- `src/security/request-body.ts` — streaming webhook byte ceiling and strict UTF-8 decode.
- `src/security/github-signature.ts` — verifies GitHub HMAC over exact received bytes.
- `src/security/evidence-crypto.ts` — AES-256-GCM application encryption with row-bound authenticated AAD.
- `src/security/retry-policy.ts` — dynamic provider-aware retry delay with bounded jitter fallback.
- `src/security/runtime-controls.ts` + `src/adapters/d1-runtime-control-store.ts` — emergency kill-switch vocabulary/storage.
- `src/security/d1-errors.ts` — classifies documented D1 read/write/database-capacity exhaustion, computes bounded recovery delay, and carries the typed marker through Workflows.
- `src/security/resource-limits.ts` — one source of truth for GitHub/evidence/replay-retention hard ceilings.
- `src/security/d1-query-budget.ts` — pre-computes D1 snapshot statement counts/chunk sizes and rejects graphs that would violate the V1.2.3 persistence budget.
- `src/adapters/d1-webhook-delivery-store.ts` — detects replay/conflict reuse of GitHub delivery IDs.

## Persistence/orchestration

- `migrations/0003_evidence.sql` — runtime controls, webhook delivery ledger, encrypted evidence items, graph edges, collection runs and database CHECK constraints.
- `migrations/0004_security_watch.sql` — adds typed `failure_code=RESOURCE_EXHAUSTED` plus indexes for fail-safe inspection and bounded replay-ledger cleanup.
- `src/adapters/d1-evidence-store.ts` — encrypts before query binding and transactionally replaces one incident evidence snapshot on retry.
- `src/adapters/d1-incident-context-store.ts` — reconstructs the minimal provider-neutral context needed for collection.
- `src/adapters/d1-incident-authorization-policy.ts` — requires known, active installation with required read permissions.
- `src/workflows/incident-workflow.ts` — policy -> kill switch -> context building -> bounded evidence collection -> fail-safe behavior; documented D1 exhaustion is converted to `NonRetryableError` and gets one best-effort fail-safe persistence attempt.
- `src/routes/github-webhook.ts` — public boundary: headers/content type/body cap/HMAC/event/control/replay checks before incident ingestion.

## Configuration/scripts

- `apps/control-plane/.dev.vars.example` — documents required local secrets, including the new evidence key.
- `apps/control-plane/wrangler.jsonc` — declares D1/Workflow bindings, encryption key version and required secret names.
- `scripts/Generate-Secrets.ps1` — PowerShell 5.1-compatible random webhook/evidence-key generator.
- `scripts/Prepare-GitHubPrivateKey.mjs` / `Set-LocalGitHubPrivateKey.ps1` — prepare the GitHub App private key without committing PEM material.
- `.github/dependabot.yml` — weekly npm + GitHub Actions dependency monitoring.
- `.github/workflows/codeql.yml` — pinned CodeQL workflow for `actions` and `javascript-typescript`; also runs the local workflow-policy gate.
- `scripts/Check-WorkflowSecurity.mjs` — semantic YAML rejection of mutable Actions refs, `pull_request_target`, `write-all`, `author_association` workflow controls and unpinned Docker actions.
- `docs/SECURITY-RELEASE-GATE.md` — local/CI/GitHub-ruleset requirements before merge/deploy.
- `docs/V1.3-EXECUTION-SECURITY.md` — mandatory future SSRF/DNS-rebinding/path/symlink/env/shell/child-agent execution controls.
- `.npmrc` — lockfile + exact-save baseline.

## Tests

- `evidence-crypto.test.ts` — encryption roundtrip and AAD/tamper resistance.
- `github-api-security.test.ts` — redirect restrictions and bounded provider reads.
- `request-body.test.ts` — webhook body budget.
- `retry-policy.test.ts` — provider retry guidance and bounded fallback.
- `github-evidence-source.test.ts` — end-to-end mocked collector graph/redaction behavior.
- `d1-errors.test.ts` — D1 resource-exhaustion classification and Workflow marker/recovery timing.
- `d1-query-budget.test.ts` — proves the maximum graph stays within the persistence statement budget.
- `normalize-event.test.ts` — regression coverage that only actionable GitHub conclusions become incidents.
- existing auth/signature/state/audit/idempotency tests remain regression coverage.
- `packages/domain/test/investigator.test.ts` / `model-gate.test.ts` — abstention, strict parsing, evidence grounding and per-call authorization tests.
- `packages/evals/test/` — corpus composition, runner/scorer, baseline, report, CLI authorization and live-adapter boundary tests.

### V1.2.2 additions
- `src/github/conclusion-policy.ts` — one incident/failure conclusion policy reused by webhook normalization and job selection.
- `src/security/oauth-admission.ts` — bounded in-isolate OAuth burst admission before D1 flow creation.
- `migrations/0005_v1_2_2_hardening.sql` — OAuth index, installation sync generations, and cleanup of pre-V1.2.2 plaintext evidence metadata snapshots.
- `docs/V1.2.2-HARDENING.md` — independent-review remediation record.


## V1.2.3 additions

- `migrations/0006_v1_2_3_recovery.sql` — invalidates pre-production evidence snapshots and rebuilds item/edge tables for recoverable AES-GCM AAD v2 plus encrypted edge metadata.
- `src/security/evidence-crypto.ts` — derives AAD only from persisted envelope fields; encrypts/decrypts complete item payloads and edge metadata; retains keyed opaque evidence indexes.
- `src/adapters/d1-evidence-store.ts` — can now `loadCollection()` from persisted ciphertext, mapping encrypted item identities back into a complete provider-neutral graph; snapshot writes remain transactional.
- `src/adapters/d1-auth-store.ts` — OAuth capacity+insert and consume+return are atomic SQL operations; installation refresh generation protections remain.
- `src/security/oauth-admission.ts` — IP-only local burst identity; `User-Agent` cannot create fresh buckets.
- `scripts/Test-WorkflowSecurityPolicy.mjs` — adversarial YAML fixtures covering aliases, expression-based `author_association`, mutable action refs and equivalent YAML syntax.
- `vitest.integration.config.ts` / `test-integration/` — Cloudflare Workers/D1 integration tier for encrypted persistence recovery/rollback/max graph, OAuth concurrency and HTTP security boundaries.
- `docs/V1.2.3-RECOVERY-HARDENING.md` — remediation rationale and remaining integration limitations.
