import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schema = JSON.parse(
  await readFile(resolve(root, "schema/customer.schema.json"), "utf8"),
);
const fields = Object.entries(schema.fields)
  .map(([name, type]) => `  ${name}: ${type};`)
  .join("\n");
const output = `// Generated from schema/customer.schema.json.\nexport interface ${schema.name} {\n${fields}\n}\n`;
await writeFile(resolve(root, "generated/customer.ts"), output, "utf8");
process.stdout.write("Generated current Customer contract.\n");
