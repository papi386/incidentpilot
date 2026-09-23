# Stale generated artifact CI fixture

This deliberately broken miniature project reproduces a realistic monorepo CI
failure. A schema adds `taxRegion`, application code starts using it, but CI
restores a generated-types cache keyed only by the dependency lockfile. The
code-generation task reports a cache hit, so the stale `Customer` interface is
used and TypeScript reports the downstream `TS2339` error in application code.

From the IncidentPilot repository root, reproduce the real compiler failure:

```powershell
npx.cmd tsc -p examples/real-world-stale-codegen-fixture/tsconfig.json
```

Expected failure:

```text
src/invoice.ts(...): error TS2339: Property 'taxRegion' does not exist on type 'Customer'.
```

Repair the generated artifact and prove that the same build passes:

```powershell
node examples/real-world-stale-codegen-fixture/scripts/generate.mjs
npx.cmd tsc -p examples/real-world-stale-codegen-fixture/tsconfig.json
```

The generated file is intentionally committed stale for the fixture. Restore
it after experimenting if you want to rerun the failing form.
