# IncidentPilot V1.2.3 Architecture

```text
GitHub App
  | signed workflow_run/check_run
  v
Webhook Gateway
  HMAC -> body cap -> event validation -> replay ledger -> kill switch
  v
IncidentService -> D1 incident + hash-chained audit -> deterministic Workflow
  v
Installation policy
  v
Evidence kill switch
  v
GitHubEvidenceSource
  |-- App JWT
  |-- repo-scoped, read-only, short-lived installation token
  |-- run/check metadata
  |-- failed jobs + bounded logs
  |-- commit/base resolution
  |-- changed files + bounded patches
  |-- derived tests/errors/stack frames
  v
redaction + NEVER_INSTRUCTIONS + provenance
  v
EvidenceCipher (AES-256-GCM + AAD)
  v
D1 transactional Evidence Graph
  |
  +-- query/statement budget + node/edge caps
```

The domain package remains infrastructure-neutral through ports. Cloudflare D1/Workflows and GitHub are adapters. V1.3 can add local or remote model providers without changing evidence/trust semantics.

The workflow stops at `CONTEXT_BUILDING` on successful/partial evidence. Security control denial moves to `SECURITY_ABORTED`; exhausted transient collection failures move to `FAILED_SAFE`.

D1 quota/capacity exhaustion takes a separate fail-safe path:

```text
D1 documented resource-exhaustion error
  -> classify RESOURCE_EXHAUSTED
  -> Cloudflare NonRetryableError (no retry storm)
  -> one best-effort direct FAILED_SAFE write
  -> workflow result remains FAILED_SAFE/RESOURCE_EXHAUSTED even if D1 cannot persist it
```

The public Worker similarly returns `503` plus `Retry-After`. Webhook delivery records use indexed four-day retention so replay defense itself cannot grow without bound.

V1.2.3 also introduces a release-time security plane: dependency-free workflow-policy checks + CodeQL for `actions` and TypeScript/JavaScript. Runtime authorization remains independent of CI.
