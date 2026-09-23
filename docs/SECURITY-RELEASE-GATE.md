# IncidentPilot Security Release Gate

This gate applies before merging or deploying IncidentPilot changes. It complements runtime controls; it does not replace them.

## 1. Local verification

Run the complete gate from the repository root:

```powershell
npm run verify
```

This includes the semantic workflow policy, its adversarial fixtures,
typechecking, unit tests, Cloudflare-native integration tests, the model-free
evaluation harness self-test and the dependency audit.

`security:workflows` is dependency-free and fails on workflow patterns that IncidentPilot does not allow:

- `pull_request_target` triggers;
- workflow security decisions based on `author_association`;
- `permissions: write-all`;
- external Actions or reusable workflows referenced by mutable tag/branch rather than a 40-character commit SHA;
- `secrets: inherit` on reusable workflows;
- Docker actions that are not pinned by `sha256` digest.

The checker scans both `.github/workflows` and local `.github/actions` YAML so a composite Action cannot hide a mutable external dependency from the top-level workflow.

The local checker is a fast policy guard. CodeQL remains the semantic workflow scanner.

## 2. CodeQL workflow

`.github/workflows/codeql.yml` scans both:

- `actions` — GitHub Actions workflow security;
- `javascript-typescript` — TypeScript/JavaScript source.

All external actions used by this repository are pinned to immutable full commit SHAs. `persist-credentials` is disabled on checkout unless a future job can document a strict need for it.

Do not weaken or remove the `actions` language because GitHub's current CodeQL releases include security queries for mutable reusable-workflow references and unsafe assumptions about event fields/author association.

## 3. GitHub merge protection

Before public/production use, create a branch ruleset for the default branch in GitHub:

1. Open **Settings -> Rules -> Rulesets**.
2. Create a branch ruleset targeting the default branch.
3. Require pull requests before merging.
4. Require the `Workflow policy` status check from `codeql.yml`.
5. Require code-scanning results from **CodeQL**.
6. For IncidentPilot, prefer blocking on **all security alerts** once the initial baseline is clean. If repository/account capabilities only expose severity thresholds, block at least `High` and `Critical` and treat Medium findings as required review.
7. Prevent bypass except for an explicitly controlled emergency administrator path.

A green CI run is not authorization for runtime agent capabilities. Runtime policy remains independently enforced.

## 4. Dependency/supply-chain gate

- Commit `package-lock.json` before production deployment.
- Review Dependabot/npm advisories; do not blindly auto-merge breaking dependency updates.
- `npm audit --audit-level=high` must not report an unresolved High/Critical finding without a documented mitigation/exception.
- New GitHub Actions/reusable workflows must be pinned to full immutable commit SHAs and reviewed before the SHA is adopted.
- Never use repository-controlled metadata such as author association as the sole security decision.

## 5. Runtime gate

Production must preserve these defaults/invariants:

```text
model_calls_enabled        = 0 until the model boundary is accepted
privileged_actions_enabled = 0 until the execution boundary is accepted
```

A release may not enable a capability solely because the LLM requests it. The policy/control plane is the enforcement point.

### Read-only investigator evaluation

- Live provider calls require an explicit `--model-calls-enabled` flag for each
  invocation; omission fails closed before provider construction.
- The reusable provider gate rechecks authorization on every request so future
  deployed wiring can use the live D1 control.
- The production incident workflow remains model-free until that wiring receives
  separate review and acceptance.
- The manual live-evaluation workflow has no automatic trigger, has read-only
  repository permissions, does not upload reports and always runs the hard
  security gate.
- Invalid schemas, fabricated citations, unauthorized capabilities, secret
  leakage and successful injection markers are release-blocking evaluation
  failures.
- Model quality metrics and regressions must be reported as observed. Do not
  alter fixtures, expected answers or thresholds to manufacture a passing run.

See `docs/V1.3-EVALUATION-HARNESS.md` for the corpus, metrics and baseline
procedure.

## 6. D1 availability gate

V1.2.3 treats D1 daily quota/capacity exhaustion as a distinct `RESOURCE_EXHAUSTED` fail-safe condition. It must not be placed into an unbounded retry loop.

Before production:

- migrations through `0004_security_watch.sql` must be applied;
- evidence graph limits and query-budget tests must pass;
- replay-ledger retention must remain bounded;
- indexes used by cleanup/failure inspection must remain present;
- operators must know how to manually redeliver a missed GitHub webhook after D1 recovers.

GitHub does not automatically guarantee recovery of failed deliveries, so fail-safe availability also requires operational redelivery/reconciliation rather than retry storms.
