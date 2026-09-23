import { createPrivateKey } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const input = process.argv[2];
const output = process.argv[3] ?? "apps/control-plane/.github-app-private-key.b64";

if (!input) {
  console.error("Usage: node scripts/Prepare-GitHubPrivateKey.mjs <github-app-private-key.pem> [output-file]");
  process.exit(1);
}

const pem = readFileSync(resolve(input), "utf8");
const key = createPrivateKey(pem);
const der = key.export({ type: "pkcs8", format: "der" });
const target = resolve(output);

writeFileSync(target, der.toString("base64") + "\n", { encoding: "utf8", mode: 0o600 });
try { chmodSync(target, 0o600); } catch { /* Windows ACLs are not POSIX mode bits. */ }

console.log(`Wrote PKCS#8 base64 private key to ${target}`);
console.log("Treat this file as a secret. Do not commit it or paste its contents into chat/logs.");
