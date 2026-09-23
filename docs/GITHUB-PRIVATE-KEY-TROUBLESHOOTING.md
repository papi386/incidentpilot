# GitHub App authentication before evidence collection

`GITHUB_AUTH_INVALID_PRIVATE_KEY` with `requests_used=0` means decoding/import
failed before the installation-token HTTP request. It does not indicate GitHub
permissions, rate limits, or an incorrect App client ID: those are checked later.

The old importer accepted only base64 of binary PKCS#8 DER. Base64 of a whole
PEM file is a different representation, even when that PEM says `PRIVATE KEY`.
The importer now accepts unencrypted RSA PKCS#1 or PKCS#8 as base64 DER, PEM,
or base64 of PEM. PEM with literal escaped newlines is also accepted. Encrypted,
non-RSA, malformed, and missing keys fail closed before network access.

New collection error codes distinguish the failure stage without including key
material or raw crypto errors:

| Code suffix after `GITHUB_AUTH_INVALID_PRIVATE_KEY_` | Meaning |
| --- | --- |
| `MISSING` | Secret binding is absent or blank. |
| `ENCODING` | Invalid base64; check that a path, assignment, or quoted command was not uploaded. |
| `FORMAT` | Invalid DER/PEM structure or unsupported envelope. |
| `ENCRYPTED` | Password-protected key; an unencrypted GitHub App key is required. |
| `IMPORT` | Web Crypto rejected the normalized key, such as a non-RSA or damaged key. |

These diagnostics require deployment of the updated Worker. Check a fresh
incident after deployment; historical D1 results retain their previous error code.
Cloudflare secret values cannot be inferred from a successful local test.

For a single canonical representation, the existing local converter remains:

```powershell
node scripts/Prepare-GitHubPrivateKey.mjs <path-to-downloaded-key.pem>
```

Its output file contains base64 DER PKCS#8. Upload the file's contents as
`GITHUB_APP_PRIVATE_KEY_B64` to the Worker/environment actually receiving the
webhooks. Do not upload the file path, variable assignment, or base64 of the
output a second time. Do not paste private keys or JWTs into issue reports.

Regression tests generate ephemeral RSA keys, verify JWT signatures against the
public key, check repository-scoped token requests, and reject bad inputs before
HTTP. The same cases run under Node and the Workers integration runtime. No real
GitHub credentials are required by those tests.

## Two incidents for one CI failure

Ingestion deduplicates by provider, repository ID, trigger type, and trigger ID.
`workflow_run` and `check_run` therefore intentionally have distinct keys today.
They are not webhook redelivery duplicates. Correlating them requires linking
checks/jobs to a workflow execution/attempt; deduplicating only by commit SHA
would incorrectly merge independent workflows and third-party checks. This
authentication fix does not change incident identity or suppress check events.
