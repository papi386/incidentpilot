import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RuntimeGatedModelProvider, type ModelProvider } from "@incidentpilot/domain";
import { OpenAiCompatibleModelProvider } from "./providers/openai-compatible-provider";
import { ContractRepairingModelProvider } from "./providers/contract-repair-provider";
import { EVALUATION_CASES, type StressCase } from "./stress/cases";
import {
  persistenceSafeStressReport,
  stressMarkdownReport,
  type StressReport,
} from "./stress/report";
import { runStressAttempt } from "./stress/runner";
import { ScriptedStressModelProvider } from "./stress/scripted-provider";

export interface StressCliOptions {
  provider: "scripted" | "openai-compatible";
  modelCallsEnabled: boolean;
  models: string[];
  casePattern: string | null;
  securityOnly: boolean;
  maximumCases: number | null;
  timeoutMs: number;
  write: boolean;
}

function nextValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

export function parseStressArgs(args: string[]): StressCliOptions {
  const options: StressCliOptions = {
    provider: "scripted",
    modelCallsEnabled: false,
    models: [],
    casePattern: null,
    securityOnly: false,
    maximumCases: null,
    timeoutMs: 120_000,
    write: true,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--provider") {
      const value = nextValue(args, index, arg);
      if (value !== "scripted" && value !== "openai-compatible") {
        throw new Error(`Unsupported provider: ${value}`);
      }
      options.provider = value;
      index += 1;
    } else if (arg === "--model-calls-enabled") {
      options.modelCallsEnabled = true;
    } else if (arg === "--models") {
      options.models = nextValue(args, index, arg)
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
      index += 1;
    } else if (arg === "--case") {
      options.casePattern = nextValue(args, index, arg);
      index += 1;
    } else if (arg === "--security-only") {
      options.securityOnly = true;
    } else if (arg === "--max-cases") {
      const value = Number(nextValue(args, index, arg));
      if (!Number.isSafeInteger(value) || value < 1 || value > EVALUATION_CASES.length) {
        throw new Error(`--max-cases must be an integer from 1 to ${EVALUATION_CASES.length}`);
      }
      options.maximumCases = value;
      index += 1;
    } else if (arg === "--timeout-ms") {
      const value = Number(nextValue(args, index, arg));
      if (!Number.isSafeInteger(value) || value < 1 || value > 120_000) {
        throw new Error("--timeout-ms must be an integer from 1 to 120000");
      }
      options.timeoutMs = value;
      index += 1;
    } else if (arg === "--no-write") {
      options.write = false;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (options.provider === "openai-compatible" && !options.modelCallsEnabled) {
    throw new Error("Live stress runs are fail-closed; pass --model-calls-enabled explicitly");
  }
  if (options.provider === "scripted" && options.models.length > 0) {
    throw new Error("--models is only valid with --provider openai-compatible");
  }
  return options;
}

function requiredProcessValue(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for live stress evaluation`);
  return value;
}

function cases(options: StressCliOptions): StressCase[] {
  let selected = options.securityOnly
    ? EVALUATION_CASES.filter((entry) => entry.category === "SECURITY")
    : [...EVALUATION_CASES];
  if (options.casePattern) {
    const pattern = options.casePattern.toLowerCase();
    selected = selected.filter((entry) =>
      entry.caseId.toLowerCase().includes(pattern) ||
      entry.category.toLowerCase().includes(pattern)
    );
  }
  if (options.maximumCases !== null) selected = selected.slice(0, options.maximumCases);
  if (selected.length === 0) throw new Error("No stress cases matched");
  return selected;
}

function liveProvider(model: string, enabled: boolean): ModelProvider {
  const provider = new OpenAiCompatibleModelProvider({
    baseUrl: requiredProcessValue("INCIDENTPILOT_EVAL_BASE_URL"),
    apiKey: requiredProcessValue("INCIDENTPILOT_EVAL_API_KEY"),
    model,
  });
  return new ContractRepairingModelProvider(
    new RuntimeGatedModelProvider(provider, async () => enabled),
  );
}

export async function stressMain(): Promise<void> {
  const options = parseStressArgs(process.argv.slice(2));
  const selected = cases(options);
  const models = options.provider === "scripted"
    ? ["scripted-stress-harness"]
    : options.models.length > 0
    ? options.models
    : [requiredProcessValue("INCIDENTPILOT_EVAL_MODEL")];
  const attempts = [];

  for (const model of models) {
    for (const testCase of selected) {
      process.stderr.write(`Stress attempt: ${model} / ${testCase.caseId}\n`);
      const provider = options.provider === "scripted"
        ? new ScriptedStressModelProvider(testCase)
        : liveProvider(model, options.modelCallsEnabled);
      attempts.push(await runStressAttempt(
        testCase,
        model,
        provider,
        options.timeoutMs,
      ));
    }
  }

  const report: StressReport = {
    schemaVersion: 1,
    runId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    provider: options.provider,
    models,
    attempts,
  };
  const markdown = stressMarkdownReport(report);
  process.stdout.write(markdown);

  if (options.write) {
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const repositoryRoot = resolve(packageRoot, "../..");
    const directory = resolve(repositoryRoot, "artifacts/stress-runs");
    await mkdir(directory, { recursive: true });
    const stamp = report.createdAt.replace(/[:.]/gu, "-");
    const markdownPath = resolve(directory, `${stamp}.md`);
    const jsonPath = resolve(directory, `${stamp}.json`);
    await writeFile(markdownPath, markdown, "utf8");
    await writeFile(
      jsonPath,
      `${JSON.stringify(persistenceSafeStressReport(report), null, 2)}\n`,
      "utf8",
    );
    process.stdout.write(`\nReports: ${markdownPath} and ${jsonPath}\n`);
  }

  if (attempts.some((entry) => entry.status === "SYSTEM_SECURITY_FAIL")) {
    process.exitCode = 2;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await stressMain();
}
