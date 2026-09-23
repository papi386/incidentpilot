# IncidentPilot — Reliability-first Evidence Agent

IncidentPilot is a reliability-first autonomous software incident engineer. V1.2.3 deliberately stops **before** LLM investigation or code execution. Its job is to receive authenticated GitHub CI/check failures, enforce authorization and runtime policy, collect a bounded evidence graph, protect repository-derived data, and persist evidence in a form that can actually be recovered later.

## Current pipeline

```text
signed GitHub webhook
  -> exact-byte HMAC verification
  -> body/content-type/event limits
  -> delivery replay/conflict ledger
  -> repository installation authorization
  -> durable Cloudflare Workflow
  -> live evidence kill-switch check on every collection attempt
  -> repository-scoped short-lived GitHub App token
  -> bounded GitHub collector
  -> redaction + injection telemetry
  -> Evidence Graph (all repository/runtime text = NEVER_INSTRUCTIONS)
  -> opaque HMAC indexes + AES-256-GCM AAD v2
  -> transactional D1 snapshot
  -> recoverable encrypted nodes + encrypted edge metadata
  -> tamper-evident audit chain
```

Evidence kinds: `WORKFLOW_RUN`, `WORKFLOW_JOB`, `JOB_LOG_EXCERPT`, `CHECK_RUN`, `CHECK_OUTPUT`, `CHANGED_FILE`, `DIFF_HUNK`, `ERROR_SIGNAL`, `FAILING_TEST`, `STACK_FRAME`.

## Evidence-agent research runtime

IncidentPilot now includes an additive, runnable evidence-agent architecture.
It is not a simple RAG pipeline: retrieval is subordinate to a control-plane
protocol that enforces competing hypotheses, targeted read-only evidence
acquisition, falsification, verification, abstention, budgets, provenance, and
an auditable conclusion gate.

```text
Evidence Graph
  -> TRIAGE
  -> typed/budgeted evidence reads
  -> VERIFY
  -> CONCLUDE proposal
  -> evidence-authority + causal-skeptic reviews
  -> deterministic adjudication
  -> DIAGNOSIS_READY or NEEDS_HUMAN
```

Run the deterministic architecture demonstration:

```powershell
npm.cmd run agent:demo -- --no-write
```

Run the same protocol against a local OpenAI-compatible/Ollama model:

```powershell
npm.cmd run agent:live -- --model-calls-enabled --timeout-ms 120000 --no-write
```

See `docs/EVIDENCE-AGENT.md` for the architecture, exact Ollama setup,
expected results, research claims, and limitations. The deployed Cloudflare
workflow remains unchanged and model calls remain disabled there.

Before using a real-incident corpus, run the fixed pre-production stress suite:

```powershell
npm.cmd run stress:self-test -- --no-write
npm.cmd run stress:live -- --model-calls-enabled --models "qwen2.5-coder:7b,qwen3:8b" --case "security-composite-control-plane-bypass" --timeout-ms 120000
```

The suite keeps hard security, causal-cascade, conflicting-evidence, and
insufficient-evidence cases unchanged and preserves observed failures under
`artifacts/stress-runs/`. See `docs/PREPRODUCTION-STRESS.md` for commands,
status meanings, the weekly-security mapping, and current honest smoke results.

The latest preserved local Qwen 2.5 run passed the unchanged eight-case matrix
with 100% contract validity, expected outcomes, containment, and model-policy
adherence (`artifacts/stress-runs/2026-09-22T12-42-00-003Z.md`). This is a
pre-production architecture result, not a real-incident accuracy claim or a
general model ranking.

A separate runnable real-world scenario now covers a monorepo task-cache key
that omits a changed schema and restores stale generated types. The raw
TypeScript build fails with `TS2339`; the latest local Qwen run correctly
localized `STALE_BUILD_ARTIFACT` rather than the downstream type or
missing-module errors. See
`examples/real-world-stale-codegen-fixture/README.md` and report
`artifacts/stress-runs/2026-09-22T13-12-47-869Z.md`.

The deployed V1.2.3 workflow contains **no model call and no privileged code execution**. `model_calls_enabled` and `privileged_actions_enabled` remain OFF by default. A separate V1.3 read-only investigator and evaluation scaffold can now consume fixture evidence in explicit test runs; it is not wired into the production incident path and cannot execute tools.

## V1.3 read-only evaluation scaffold

The additive `@incidentpilot/evals` workspace provides 40 deterministic cases: 15 correctness, 5 ambiguous, 5 insufficient-evidence, 5 conflicting-evidence and 10 adversarial prompt-injection cases. It measures strict-schema validity, grounded citations, root-cause ranking, abstention, confidence calibration, latency, tokens and optional estimated cost. Security failures are hard-gated; ordinary quality results are recorded honestly and are not forced to pass.

Run the model-free harness check with:

```powershell
npm run eval:self-test
```

Real-provider runs require both provider configuration and an explicit per-run authorization flag:

```powershell
npm.cmd run eval:live -- --model-calls-enabled --gate-security --timeout-ms 120000 --repeat 3
```

On Windows PowerShell, use `npm.cmd` for live runs so npm forwards every
double-dash option to the evaluation CLI. The live-evaluation timeout defaults
to 120 seconds and can be lowered with `--timeout-ms`.

The scripted self-test validates the harness only and must not be presented as model performance. Live evaluations can also be started manually with the read-only `Live Model Evaluation` GitHub workflow. See `docs/V1.3-EVALUATION-HARNESS.md` for the operating model, metrics, baseline process and limitations.

## V1.2.3 hardening changes

### Recoverable encrypted evidence

V1.2.2 protected raw dedupe keys with a keyed HMAC, but its AES-GCM AAD still depended on the original plaintext dedupe key. That made persisted evidence impossible to decrypt after the in-memory draft was discarded.

V1.2.3 uses **AAD version 2**. Item AAD is built only from values that are persisted outside ciphertext, including the opaque HMAC dedupe identifier, incident ID, evidence type/security classes and collection time. The original dedupe key, source identifiers/URLs, content hash, content and metadata stay inside ciphertext.

`D1EvidenceStore.loadCollection()` reconstructs the full provider-neutral evidence graph from D1 using only persisted rows + the encryption key. Edge metadata is now AES-GCM encrypted and recovered too.

### OAuth concurrency and abuse hardening

- Local burst identity is based on `CF-Connecting-IP`, not attacker-controlled `User-Agent`.
- Expired/consumed OAuth cleanup remains bounded and indexed.
- Capacity admission and OAuth-flow insertion happen in one `INSERT ... SELECT ... RETURNING` statement, so concurrent requests cannot all observe the same free slot.
- Consumption uses one `UPDATE ... RETURNING` statement, preventing cleanup from deleting a consumed flow between update and read.
- Deployment-edge rate limiting is still required against distributed abuse; the in-process limiter is defense-in-depth, not the global authority.

### Semantic workflow-policy enforcement

`scripts/Check-WorkflowSecurity.mjs` parses YAML semantics rather than line formats. Alias expansion is bounded, aliases are resolved before inspection, and security-sensitive strings are recursively inspected. The policy rejects mutable action/reusable-workflow refs, `pull_request_target`, `write-all`, `secrets: inherit`, unpinned Docker actions, and `author_association` security logic even when it appears inside expressions.

### Cloudflare-native integration tests

V1.2.3 adds a second test tier using the current Cloudflare Vitest integration. It applies the real D1 migrations and exercises:

- encrypted save -> discard drafts -> reload -> decrypt complete items and edges;
- transactional rollback when an edge write fails;
- maximum evidence graph persistence/reload;
- concurrent OAuth capacity admission and atomic consumption;
- HTTP invalid-signature and delivery-conflict behavior;
- OAuth browser-binding and expiry rejection before provider exchange;
- correctly hashed expired sessions and logout session revocation.

Unit tests remain useful, but the project no longer treats unit green status as sufficient evidence for the D1/route boundaries.

## Security invariants

- GitHub webhook HMAC is verified over exact received bytes before JSON parsing.
- Webhook body size, content type and event type are bounded/validated.
- Delivery IDs are bound to body SHA-256; conflicting reuse is rejected.
- Installation tokens are just-in-time, one-repository scoped, minimum-permission and never persisted.
- Request deadlines cover **headers and complete response-body consumption**.
- Log redirects are manually validated and downloaded without the GitHub bearer token.
- Local security validation failures such as unsafe redirects are non-retryable security failures, not disguised provider 5xx failures.
- Repository/log/diff/check text remains `NEVER_INSTRUCTIONS` regardless of provenance or detector output.
- Sensitive-looking content is redacted before application-level encryption.
- D1 stores opaque keyed evidence indexes, not raw repository filenames/dedupe keys.
- Item and edge metadata that can contain repository-derived data is encrypted.
- AES-GCM AAD v2 is reconstructible entirely from persisted envelope fields.
- Evidence snapshots are bounded and replaced transactionally.
- D1 quota/capacity exhaustion is classified `RESOURCE_EXHAUSTED` and does not create a retry storm.
- Runtime controls are live policy. Evidence collection re-reads its kill switch **inside each retry attempt before credentials/API access**.
- Future model and privileged-action controls default OFF.

See `docs/SECURITY.md`, `docs/V1.2.3-RECOVERY-HARDENING.md`, and `docs/V1.3-EXECUTION-SECURITY.md`.

For a complete restart guide—from local validation through one real model run
and a disposable GitHub end-to-end failure—see `docs/RUNBOOK.md`.

## Bounded collection budgets

Current ceilings include 16 GitHub HTTP calls, 4 actionable failed jobs, 256 KiB per job log, 768 KiB aggregate job logs, 48 evidence items, 96 graph edges, 12 changed files, 8 persisted diff hunks, 4,000 characters per diff hunk, and 6,000 characters of check output. Provider JSON bodies are size-bounded before parsing.

Under the current encrypted schema, a maximum 48-node/96-edge graph is budgeted at **24 persistence statements**, with a hard budget of 24, below the Workers Free per-invocation D1 query ceiling used by this design.

## Migrations

```text
0001_initial.sql
0002_auth.sql
0003_evidence.sql
0004_security_watch.sql
0005_v1_2_2_hardening.sql
0006_v1_2_3_recovery.sql
```

`0006_v1_2_3_recovery.sql` deliberately clears **pre-production evidence snapshots only** and rebuilds the evidence tables for AAD v2 + encrypted edge metadata. It does **not** delete incidents, users, sessions or GitHub installation associations.

## Required local secrets

Keep secrets only in `apps/control-plane/.dev.vars` locally and Cloudflare secrets in deployment. V1.2.3 still requires:

```text
GITHUB_WEBHOOK_SECRET=...
GITHUB_APP_CLIENT_SECRET=...
GITHUB_APP_PRIVATE_KEY_B64=...
EVIDENCE_ENCRYPTION_KEY_B64=<base64 of exactly 32 random bytes>
```

Never commit or paste these values into chat/logs.

## Install / validate

From the repository root:

```powershell
npm install
npm run cf:types
npm run db:migrate:local
npm run verify
```

`npm run verify` now runs:

```text
semantic workflow policy
adversarial workflow-policy fixtures
strict TypeScript typecheck
unit tests
Cloudflare-native integration tests
model-free investigator/evaluation harness self-test
npm audit --audit-level=high
```

You can run the integration tier directly with:

```powershell
npm run test:integration -w @incidentpilot/control-plane
```

## Current non-claims

V1.2.3 is not claimed to be zero-day-proof, formally verified, SOC 2 certified, GDPR compliant, or a secure arbitrary-code sandbox. It still has no privileged execution plane. A true Cloudflare **durable Workflow end-to-end integration harness** remains a separate acceptance item; current integration coverage exercises real local D1 adapters and Worker HTTP routes, while workflow failure/retry semantics are still covered primarily by unit/adversarial tests and local runtime acceptance.

## Next milestone

After V1.2.3 passes on the user's Windows/Cloudflare local runtime, test one real authorized GitHub repository with deliberately failing CI and verify:

```text
real signed workflow/check webhook
-> authorized installation
-> scoped token
-> jobs/logs/diff
-> redaction/trust classification
-> encrypted Evidence Graph
-> D1 reload/decryption
```

The next V1.3 step is to run the read-only harness against an explicitly selected real model, review the observed failures, and establish the first honest baseline. Production workflow integration and every execution capability remain separate acceptance decisions.
