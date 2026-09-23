import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { parseDocument } from "yaml";

const policyRoots = [path.resolve(".github/workflows"), path.resolve(".github/actions")];
const sha40 = /^[0-9a-f]{40}$/i;

async function yamlFilesUnder(root) {
  const found = [];
  async function walk(dir) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && /\.ya?ml$/iu.test(entry.name)) found.push(full);
    }
  }
  await walk(root);
  return found;
}

function triggerNames(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(triggerNames);
  if (value && typeof value === "object") return Object.keys(value);
  return [];
}

function inspectUses(violations, uses) {
  if (typeof uses !== "string" || uses.startsWith("./")) return;
  if (uses.startsWith("docker://")) {
    if (!/@sha256:[0-9a-f]{64}$/iu.test(uses)) violations.push(`container action must be pinned by sha256 digest: ${uses}`);
    return;
  }
  const at = uses.lastIndexOf("@");
  if (at <= 0 || !sha40.test(uses.slice(at + 1))) {
    violations.push(`external action/reusable workflow must use a full immutable 40-character commit SHA: ${uses}`);
  }
}

function inspectValue(value, violations, key = "") {
  if (typeof value === "string") {
    if (/author[_-]association/iu.test(value)) {
      violations.push("author_association must not be used as a security boundary");
    }
    if (key === "permissions" && value === "write-all") violations.push("permissions: write-all is forbidden");
    if (key === "secrets" && value === "inherit") violations.push("secrets: inherit is forbidden");
    if (key === "uses") inspectUses(violations, value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) inspectValue(item, violations, key);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [childKey, childValue] of Object.entries(value)) {
    if (/author[_-]association/iu.test(childKey)) {
      violations.push("author_association must not be used as a security boundary");
    }
    inspectValue(childValue, violations, childKey);
  }
}

export function inspectWorkflowText(text) {
  const violations = [];
  const doc = parseDocument(text, { strict: true, uniqueKeys: true });
  if (doc.errors.length > 0) {
    return [`invalid YAML: ${doc.errors.map((error) => error.message).join("; ")}`];
  }

  let root;
  try {
    // Resolve aliases/anchors, but put a hard bound on expansion so the policy
    // checker itself cannot be abused with an alias-expansion bomb.
    root = doc.toJS({ maxAliasCount: 32 });
  } catch (error) {
    return [`unsafe/unresolvable YAML aliases: ${error instanceof Error ? error.message : "unknown error"}`];
  }
  if (!root || typeof root !== "object" || Array.isArray(root)) {
    return ["workflow/action YAML must be a mapping"];
  }

  if (triggerNames(root.on).includes("pull_request_target")) {
    violations.push("pull_request_target is forbidden; privileged workflows must never execute untrusted PR code");
  }
  inspectValue(root, violations);
  return [...new Set(violations)];
}

export async function inspectWorkflowFiles(roots = policyRoots) {
  const violations = [];
  const groups = await Promise.all(roots.map(yamlFilesUnder));
  for (const file of groups.flat()) {
    const text = await readFile(file, "utf8");
    for (const message of inspectWorkflowText(text)) {
      violations.push(`${path.relative(process.cwd(), file)}: ${message}`);
    }
  }
  return violations;
}

async function main() {
  const violations = await inspectWorkflowFiles();
  if (violations.length > 0) {
    console.error("GitHub Actions security policy violations:\n");
    for (const violation of violations) console.error(`- ${violation}`);
    process.exit(1);
  }
  console.log("GitHub Actions security policy: PASS");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
