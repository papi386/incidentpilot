# Evaluation baselines

This directory intentionally contains no fabricated model baseline.

Create the first baseline only after running a real model and reviewing the
result:

```powershell
npm.cmd run eval:live -- --model-calls-enabled --timeout-ms 120000 --write-baseline first-observed
```

The baseline records observed results, including failures. It is not edited to
make metrics look better. Harness self-tests use a scripted provider and must
never be saved or presented as model performance.

Compare a later run without failing on ordinary quality movement:

```powershell
npm.cmd run eval:live -- --model-calls-enabled --timeout-ms 120000 --compare-baseline first-observed.json
```

Add `--gate-quality` only after the team accepts the dataset and baseline.
Security invariants can be gated independently with `--gate-security`.
