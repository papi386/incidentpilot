# Deterministic GitHub source routing

Signature verification precedes parsing, provider routing and D1 policy lookup.
The router recognizes GitHub.com's first-party GitHub Actions app ID `15368`
and requires the consistent `github-actions` slug. It never trusts check names,
sender names, output text, details URLs, or an LLM classification. Enterprise
instances require a reviewed host/app-identity configuration before use.

| Disposition | Result |
| --- | --- |
| CANONICAL_TRIGGER | Authorized failed workflow_run creates/reuses an incident. |
| SUPPORTING_ONLY | GitHub Actions check_run completes delivery processing with no incident/workflow. |
| INDEPENDENT_TRIGGER | Failed check_run from an operator-approved app creates/reuses an independent incident. |
| PENDING_VERIFICATION | Missing/unknown/inconsistent identity or unknown installation; no execution. |
| REJECTED | Invalid provider fields, non-failure event, suspended installation, or insufficient trigger permissions. |

Independent-provider approval is stored in `trusted_check_providers`, keyed by
installation ID, repository ID and app ID, with an explicit enabled bit. It is
empty by default. Only an operator may populate it after verifying the provider
identity and repository policy. Authenticated external checks do not gain this
approval automatically. The workflow still rechecks installation authorization.

The delivery ledger records only validated numeric source/repository/app/suite
IDs, fixed disposition/reason codes, and a routing version. No check output or
repository paths are copied into it. The first persisted routing decision wins.
`processed_at`, rather than `incident_id`, marks completed processing. A pending
delivery stays pending on replay, even after policy changes; promotion requires
future explicit reconciliation. Supporting signals never become incidents on a
timeout. The existing four-day bounded retention also applies to these records;
this is not a permanent signal archive. Rich attachment/reconciliation is deferred.

Canonical workflow keys retain the existing repository/run identity. Different
workflows on the same SHA remain separate; reruns retain the existing incident
behavior. Attempt-versioned recollection is not added by this patch.

## Deployment and the historical E2E pair

Migration 0007 is additive and preserves incidents, evidence, and audit events.
Apply it before deploying the new Worker. Do not blindly run all pending old
migrations: 0005/0006 are pre-production recovery migrations which invalidate old
evidence. Confirm 0001–0006 are already applied on the E2E database first.

```powershell
cd C:\dev\incidentpilot-v1
npx wrangler d1 migrations list DB --remote --config apps/control-plane/wrangler.jsonc
# If only 0007 is pending:
npm run db:migrate:remote
npm run deploy
```

Both E2E workflows should be finished before marking their relationship. The
operator explicitly identified `f1646d3a...` as the duplicate check and `96ad8991...`
as its canonical workflow. This script resolves those prefixes unambiguously and
checks trigger types, matching repository and SHA. It aborts for missing/ambiguous
IDs or a conflicting relationship. Matching SHA alone is not correlation proof;
the operation relies on the operator-confirmed E2E relationship.

```powershell
npx wrangler d1 execute DB --remote --config apps/control-plane/wrangler.jsonc --file scripts/Supersede-E2E-Check.sql
```

This writes an immutable `incident_supersessions` audit record. Original incident
statuses, evidence and the existing `audit_events` chain are preserved. The
authorization policy denies superseded incidents, and workflow entry plus each
collection retry checks supersession before doing work. It does not interrupt a
collection already in flight. No live remote mutation was performed by this patch.

## V1.3 boundary

An LLM cannot choose a routing disposition, approve a provider, clear supersession,
or promote a supporting/pending event. Repository-derived evidence stays
`NEVER_INSTRUCTIONS`. Model/privileged-action controls remain OFF. Future action
brokers must recheck supersession, permissions, kill switches, shared budgets and
required approvals when claiming/executing work. Leases, fencing, durable action
idempotency and external-result reconciliation remain prerequisites for V1.3;
this router is not an exactly-once model/PR execution guarantee.

## Verification

Workers integration tests exercise signed HTTP requests and real D1/Workflow
bindings: both event orders, concurrent duplicate and same-ID deliveries, multiple
Actions checks, unknown/spoofed identities, installation suspension, scoped external
approvals, policy changes on replay, separate runs on one SHA, and supersession.
Routing tests disable collection to isolate the orchestration invariant; existing
collector, crypto, and workflow suites cover the subsequent boundaries. Resume
real Go/Node E2E only after deployment and verify one workflow incident, supporting
check dispositions with null incident IDs, and bounded evidence collection.
