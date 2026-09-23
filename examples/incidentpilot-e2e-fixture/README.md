# IncidentPilot disposable E2E fixture

Copy the **contents** of this directory into the root of a new, disposable
GitHub repository. Do not add it to an important repository.

The implementation in `src/total.js` is deliberately wrong. The expected first
result is one failing Node test:

```text
Expected values to be strictly equal:
41 !== 42
```

The GitHub workflow runs only when manually dispatched. Its failure should
produce one canonical `workflow_run` incident in IncidentPilot and bounded,
encrypted evidence.

After the failed run is fully collected, change:

```js
return values.reduce((sum, value) => sum + value, 0) - 1;
```

to:

```js
return values.reduce((sum, value) => sum + value, 0);
```

Commit the fix and dispatch the workflow again. The test should pass, and the
successful workflow must not create a new failure incident.
