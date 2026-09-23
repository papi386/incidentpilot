import fs from "node:fs/promises";

import {
  EvidenceCipher,
} from "../src/security/evidence-crypto.ts";

const inputPath = process.argv[2];

if (!inputPath) {
  throw new Error(
    "Usage: node inspect-evidence.mjs <wrangler-json-file>",
  );
}

const keyB64 =
  process.env.EVIDENCE_ENCRYPTION_KEY_B64;

const keyVersion =
  process.env.EVIDENCE_ENCRYPTION_KEY_VERSION;

if (!keyB64) {
  throw new Error(
    "EVIDENCE_ENCRYPTION_KEY_B64 is not set",
  );
}

if (!keyVersion) {
  throw new Error(
    "EVIDENCE_ENCRYPTION_KEY_VERSION is not set",
  );
}

const raw =
  (
    await fs.readFile(
      inputPath,
      "utf8",
    )
  ).replace(/^\uFEFF/u, "");

const parsed =
  JSON.parse(raw);

const resultSets =
  Array.isArray(parsed)
    ? parsed
    : [parsed];

const rows =
  resultSets.flatMap(
    (entry) =>
      entry.results ?? [],
  );

if (rows.length === 0) {
  throw new Error(
    "No evidence rows found",
  );
}

const cipher =
  new EvidenceCipher(
    keyB64,
    keyVersion,
  );

for (const row of rows) {
  const item =
    await cipher.decryptItem({
      incidentId:
        row.incident_id,

      opaqueDedupeKey:
        row.dedupe_key,

      kind:
        row.kind,

      sourceKind:
        row.source_kind,

      integrity:
        row.integrity,

      contentClass:
        row.content_class,

      sensitivity:
        row.sensitivity,

      instructionTrust:
        row.instruction_trust,

      collectedAt:
        row.collected_at,

      ciphertextB64:
        row.ciphertext_b64,

      nonceB64:
        row.nonce_b64,

      aadVersion:
        row.aad_version,

      keyVersion:
        row.key_version,
    });

  console.log(
    "\n============================================================",
  );

  console.log(
    `KIND: ${item.kind}`,
  );

  console.log(
    `TRUST: ${item.instructionTrust}`,
  );

  console.log(
    `INTEGRITY: ${item.integrity}`,
  );

  console.log(
    `SENSITIVITY: ${item.sensitivity}`,
  );

  console.log(
    "METADATA:",
  );

  console.log(
    JSON.stringify(
      item.metadata,
      null,
      2,
    ),
  );

  console.log(
    "CONTENT:",
  );

  console.log(
    item.content,
  );
}