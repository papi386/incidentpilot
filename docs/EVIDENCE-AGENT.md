# IncidentPilot Evidence Agent

Status: additive research runtime. It does not replace or silently enable the
deployed Cloudflare incident workflow.

## Research claim

IncidentPilot is not a chat interface over retrieved log fragments. It is an
evidence-first software incident investigator in which the control plane, not
the language model, owns authority and procedure.

The current demonstration implements:

```text
authenticated Evidence Graph
  -> deterministic evidence-readiness check
  -> TRIAGE: competing causal hypotheses
  -> bounded typed evidence reads
  -> VERIFY: support, weaken, or reject hypotheses
  -> CONCLUDE proposal
  -> evidence-authority review
  -> causal-skeptic review
  -> deterministic adjudication
  -> evidence-cited diagnosis or abstention
```

Retrieval is one supporting mechanism. The product-level behavior comes from:

- provenance-preserving evidence;
- explicit causal hypotheses and falsifiers;
- a control-plane state machine;
- typed read-only tools;
- query/model budgets and duplicate-probe rejection;
- verification before conclusion;
- sparse role-specialized review rather than free-form agent debate;
- high-precision deterministic causal signals for assertion/diff and
  install/lockfile failures;
- deterministic derivation of aggregate reviewer verdicts from typed findings;
- one visible, bounded repair for schema, citation-namespace, duplicate-read,
  target, or log-range errors;
- a public root-cause taxonomy with `OTHER` and `UNKNOWN`;
- strict structured outputs and evidence-reference validation;
- an auditable trajectory without storing private chain-of-thought;
- separation between recommendations and executed actions.

## Why this architecture

The previous investigator performed one model call over a static fixture. That
path remains available for regression comparisons. The evidence-agent path is
additive and can recover missing context through controlled reads without
granting the model shell, network, credentials, repository writes, or approval
authority.

This is a bounded agent protocol rather than an unconstrained ReAct loop. The
runtime determines which phase is active, validates every model response,
enforces the tool budget, records tool provenance, and refuses a diagnosis
whose root-cause class was not marked `SUPPORTED` during verification.

The stress runtime adds two non-tool-using specialists. The evidence-authority
role checks what each source is permitted to establish; the causal skeptic
tries to falsify the selected mechanical cause. They cannot communicate with
one another or expand their authority. The deterministic adjudicator selects
the verified cause set, rejects unselected conclusion claims, derives the
aggregate verdict from per-cause findings, and permits a causal-rule override
only for narrow evidence patterns. A product-intent conflict still abstains.

## Architecture boundaries

The reusable domain implementation is in:

- `packages/domain/src/agentic-investigator.ts`
- `packages/domain/src/multi-agent-investigator.ts`
- `packages/domain/src/investigation-tools.ts`
- `packages/domain/src/root-cause-taxonomy.ts`

The local research/demo adapters are in:

- `packages/evals/src/agent-cli.ts`
- `packages/evals/src/agent/`

The production workflow is unchanged. Model calls and privileged actions stay
OFF there. A future production evidence broker can implement the same
`ReadOnlyEvidenceBroker` port while preserving the existing authorization,
encryption, and kill-switch controls.

## Run the deterministic architecture demonstration

From `C:\dev\incidentpilot-v1`:

```powershell
npm install
npm.cmd run typecheck
npm.cmd test
npm.cmd run agent:demo -- --no-write
```

Expected result:

- `DIAGNOSIS_READY`;
- root-cause class `UNIT_ASSERTION_REGRESSION`;
- confidence `0.93` from the scripted demonstration;
- three model-phase calls;
- three typed read-only evidence calls;
- one supported and one rejected hypothesis;
- a 12-event audit trajectory;
- no recommendation execution.

The scripted values demonstrate runtime behavior only. They are not model or
product performance.

Omit `--no-write` to create Markdown and JSON reports under
`artifacts/agent-runs/`.

## Run the same protocol with a free local Ollama model

Start Ollama and make sure the selected model is installed. In a new
PowerShell window:

```powershell
cd C:\dev\incidentpilot-v1
$env:INCIDENTPILOT_EVAL_BASE_URL = "http://localhost:11434/v1/"
$env:INCIDENTPILOT_EVAL_MODEL = "qwen2.5-coder:7b"
$env:INCIDENTPILOT_EVAL_API_KEY = "ollama"
npm.cmd run agent:live -- --model-calls-enabled --timeout-ms 120000 --no-write
```

Important: type the URL as the plain quoted string shown above. Do not paste a
Markdown link such as `[http://...](http://...)` into PowerShell.

This protocol normally makes three model calls and can make a fourth when a
verification round requests additional evidence. A local 8B model can
therefore take several minutes. The timeout applies separately to each call.

Possible honest outcomes:

- `DIAGNOSIS_READY`: the final class passed the verification gate and cites
  retained or broker-acquired evidence.
- `NEEDS_HUMAN`: the agent completed but found the evidence insufficient.
- a validation error: the response and its single visible repair both violated
  the strict contract. Every physical attempt is counted and security-scanned;
  no response is repaired invisibly.
- a timeout: the local model exceeded the per-call latency budget.

## Evaluation semantics corrected

The one-shot investigator now receives the same versioned root-cause taxonomy
used by its evaluator. It is no longer expected to guess a hidden label.

Evaluation also separates:

- forbidden capability requests, which are security failures; and
- supported but case-irrelevant read-only recommendations, which are quality
  findings rather than security incidents.

The original 40 synthetic cases remain contract/security tests. They are not
presented as end-to-end product performance because they still use prepared
Evidence Graph fixtures rather than raw GitHub API/log inputs.

## Ingestion improvements included in this milestone

The log reducer now uses a deterministic hybrid strategy:

- context around high-signal lines;
- reserved context for the first and last signals;
- a bounded log tail;
- reverse-priority filling so late fatal causes survive early retry noise.

Changed files are ranked by exact paths extracted from failing tests, compiler
diagnostics, and stack frames before file/patch caps are applied. Long patches
preserve both their beginning and end. File-link edges are now produced for
all structured signals with safe exact paths, not only stack frames.

## What still must not be claimed

- The scripted demo is not an accuracy benchmark.
- The 40-case fixture suite is not a real-incident benchmark.
- The evidence agent is not wired into production Cloudflare Workflows.
- It does not execute tests, patches, shell commands, or repository writes.
- The current taxonomy is an initial version and requires expert annotation
  guidelines and accepted-equivalence rules.
- A credible model comparison still requires real raw CI failures, multiple
  runs, component metrics, and confidence intervals.

The fixed hard-case bridge before that milestone is documented in
`docs/PREPRODUCTION-STRESS.md`. Its failures are retained and are not converted
into passing cases by changing labels or expected outcomes.

## Next research milestone

Build a reviewed corpus of real GitHub Actions failures where every case starts
from raw provider responses and proceeds through collector, reducer, parser,
encrypted persistence/reload, evidence agent, and scoring. Measure ingestion
recall, causal localization, claim faithfulness, trajectory quality,
abstention, latency, and security independently.
