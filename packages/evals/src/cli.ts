import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  RuntimeGatedModelProvider,
  type ModelProvider,
} from "@incidentpilot/domain";
import { compareBaseline, type QualityRegressionPolicy } from "./baseline";
import { EVALUATION_CASES } from "./cases/catalog";
import { OpenAiCompatibleModelProvider } from "./providers/openai-compatible-provider";
import { ScriptedModelProvider } from "./providers/scripted-provider";
import { markdownReport, persistenceSafeReport, writeReports } from "./report";
import { evaluateSuite } from "./runner";
import type {
  EvaluationCase,
  EvaluationReport,
  TokenPricing,
} from "./types";

export interface CliOptions {
  provider: "scripted" | "openai-compatible";
  modelCallsEnabled: boolean;
  write: boolean;
  gateSecurity: boolean;
  gateQuality: boolean;
  repeat: number;
  timeoutMs: number;
  casePattern: string | null;
  writeBaseline: string | null;
  compareBaseline: string | null;
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const reportDirectory = resolve(repositoryRoot, "artifacts/evals");
const baselineDirectory = resolve(packageRoot, "baselines");

function nextValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    provider: "scripted",
    modelCallsEnabled: false,
    write: true,
    gateSecurity: false,
    gateQuality: false,
    repeat: 1,
    timeoutMs: 120_000,
    casePattern: null,
    writeBaseline: null,
    compareBaseline: null,
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
    } else if (arg === "--no-write") {
      options.write = false;
    } else if (arg === "--gate-security") {
      options.gateSecurity = true;
    } else if (arg === "--gate-quality") {
      options.gateQuality = true;
    } else if (arg === "--repeat") {
      const value = Number(nextValue(args, index, arg));
      if (!Number.isSafeInteger(value) || value < 1 || value > 10) {
        throw new Error("--repeat must be an integer from 1 to 10");
      }
      options.repeat = value;
      index += 1;
    } else if (arg === "--timeout-ms") {
      const value = Number(nextValue(args, index, arg));
      if (!Number.isSafeInteger(value) || value < 1 || value > 120_000) {
        throw new Error("--timeout-ms must be an integer from 1 to 120000");
      }
      options.timeoutMs = value;
      index += 1;
    } else if (arg === "--case") {
      options.casePattern = nextValue(args, index, arg);
      index += 1;
    } else if (arg === "--write-baseline") {
      options.writeBaseline = nextValue(args, index, arg);
      index += 1;
    } else if (arg === "--compare-baseline") {
      options.compareBaseline = nextValue(args, index, arg);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (options.provider === "scripted" && options.writeBaseline) {
    throw new Error("Scripted harness results cannot be saved as a model baseline");
  }
  if (options.gateQuality && !options.compareBaseline) {
    throw new Error("--gate-quality requires --compare-baseline");
  }
  if (
    options.provider === "openai-compatible" &&
    !options.modelCallsEnabled
  ) {
    throw new Error(
      "Live evaluation is fail-closed; pass --model-calls-enabled explicitly",
    );
  }

  return options;
}

function requiredProcessValue(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for live evaluation`);
  return value;
}

function optionalNumber(name: string): number | undefined {
  const value = process.env[name];
  if (value === undefined || value === "") return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return number;
}

function liveProvider(): { provider: ModelProvider; modelId: string } {
  const modelId = requiredProcessValue("INCIDENTPILOT_EVAL_MODEL");
  return {
    modelId,
    provider: new OpenAiCompatibleModelProvider({
    baseUrl: requiredProcessValue("INCIDENTPILOT_EVAL_BASE_URL"),
    apiKey: requiredProcessValue("INCIDENTPILOT_EVAL_API_KEY"),
      model: modelId,
    }),
  };
}

function pricing(): TokenPricing | undefined {
  const inputUsdPerMillion = optionalNumber(
    "INCIDENTPILOT_EVAL_INPUT_USD_PER_MILLION",
  );
  const outputUsdPerMillion = optionalNumber(
    "INCIDENTPILOT_EVAL_OUTPUT_USD_PER_MILLION",
  );

  return inputUsdPerMillion === undefined || outputUsdPerMillion === undefined
    ? undefined
    : { inputUsdPerMillion, outputUsdPerMillion };
}

function selectedCases(options: CliOptions): EvaluationCase[] {
  const selected = options.casePattern
    ? EVALUATION_CASES.filter((entry) =>
        entry.caseId.includes(options.casePattern!) ||
        entry.category.includes(options.casePattern!.toUpperCase())
      )
    : EVALUATION_CASES;

  if (selected.length === 0) throw new Error("No evaluation cases matched");

  return Array.from({ length: options.repeat }, (_, repeatIndex) =>
    selected.map((entry) => ({
      ...entry,
      caseId: options.repeat === 1
        ? entry.caseId
        : `${entry.caseId}#${repeatIndex + 1}`,
    })),
  ).flat();
}

function safeBaselineName(name: string): string {
  if (!/^[a-z0-9][a-z0-9._-]{0,80}$/iu.test(name)) {
    throw new Error("Baseline name may contain only letters, digits, dot, dash and underscore");
  }
  return name.endsWith(".json") ? name : `${name}.json`;
}

async function readReport(path: string): Promise<EvaluationReport> {
  return JSON.parse(await readFile(path, "utf8")) as EvaluationReport;
}

export async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const cases = selectedCases(options);
  const live = options.provider === "openai-compatible"
    ? liveProvider()
    : null;
  const sharedLiveProvider = live
    ? new RuntimeGatedModelProvider(
        live.provider,
        async () => options.modelCallsEnabled,
      )
    : null;

  const report = await evaluateSuite(
    cases,
    (testCase) => sharedLiveProvider ?? new ScriptedModelProvider(
      testCase.referenceOutput,
    ),
    {
      runKind: options.provider === "scripted"
        ? "HARNESS_SELF_TEST"
        : "LIVE_MODEL_EVALUATION",
      timeoutMs: options.timeoutMs,
      ...(live ? { modelIdHint: live.modelId } : {}),
      ...(pricing() === undefined ? {} : { pricing: pricing()! }),
    },
  );

  process.stdout.write(markdownReport(report));

  if (options.write) {
    const paths = await writeReports(report, reportDirectory);
    process.stdout.write(`\nReports: ${paths.markdown} and ${paths.json}\n`);
  }

  if (options.writeBaseline) {
    await mkdir(baselineDirectory, { recursive: true });
    const target = resolve(
      baselineDirectory,
      safeBaselineName(options.writeBaseline),
    );
    if (dirname(target) !== baselineDirectory) {
      throw new Error("Baseline path escaped its directory");
    }
    await writeFile(
      target,
      `${JSON.stringify(persistenceSafeReport(report), null, 2)}\n`,
      "utf8",
    );
    process.stdout.write(`Baseline written: ${target}\n`);
  }

  let qualityPassed = true;
  if (options.compareBaseline) {
    const baselinePath = resolve(
      baselineDirectory,
      safeBaselineName(options.compareBaseline),
    );
    if (dirname(baselinePath) !== baselineDirectory) {
      throw new Error("Baseline path escaped its directory");
    }
    const thresholdConfig = JSON.parse(
      await readFile(resolve(packageRoot, "thresholds.json"), "utf8"),
    ) as { qualityRegression: QualityRegressionPolicy };
    const comparison = compareBaseline(
      report,
      await readReport(baselinePath),
      thresholdConfig.qualityRegression,
    );
    qualityPassed = comparison.passed;
    process.stdout.write(`Baseline comparison: ${JSON.stringify(comparison, null, 2)}\n`);
  }

  if (options.gateSecurity && !report.securityGate.passed) {
    process.exitCode = 2;
  }
  if (options.gateQuality && !qualityPassed) {
    process.exitCode = 3;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await main();
}
