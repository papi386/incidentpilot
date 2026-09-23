import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  AgenticReadOnlyInvestigator,
  RuntimeGatedModelProvider,
  type ModelProvider,
} from "@incidentpilot/domain";
import { buildAgentDemoCase } from "./agent/demo-case";
import { InMemoryEvidenceBroker } from "./agent/in-memory-broker";
import { agentMarkdownReport } from "./agent/report";
import { ScriptedAgentModelProvider } from "./agent/scripted-agent-provider";
import { OpenAiCompatibleModelProvider } from "./providers/openai-compatible-provider";

interface Options {
  provider: "scripted" | "openai-compatible";
  modelCallsEnabled: boolean;
  timeoutMs: number;
  write: boolean;
}

function nextValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

export function parseAgentArgs(args: string[]): Options {
  const options: Options = {
    provider: "scripted",
    modelCallsEnabled: false,
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
    throw new Error("Live agent runs are fail-closed; pass --model-calls-enabled explicitly");
  }
  return options;
}

function requiredProcessValue(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for a live agent run`);
  return value;
}

function provider(options: Options): ModelProvider {
  if (options.provider === "scripted") return new ScriptedAgentModelProvider();
  const delegate = new OpenAiCompatibleModelProvider({
    baseUrl: requiredProcessValue("INCIDENTPILOT_EVAL_BASE_URL"),
    apiKey: requiredProcessValue("INCIDENTPILOT_EVAL_API_KEY"),
    model: requiredProcessValue("INCIDENTPILOT_EVAL_MODEL"),
  });
  return new RuntimeGatedModelProvider(
    delegate,
    async () => options.modelCallsEnabled,
  );
}

export async function agentMain(): Promise<void> {
  const options = parseAgentArgs(process.argv.slice(2));
  const demo = buildAgentDemoCase();
  const broker = new InMemoryEvidenceBroker(demo.collection, demo.artifacts);
  const investigator = new AgenticReadOnlyInvestigator(
    provider(options),
    broker,
    { timeoutMs: options.timeoutMs },
  );
  const result = await investigator.investigate(demo.collection);
  const createdAt = new Date().toISOString();
  const markdown = agentMarkdownReport(demo.title, result, createdAt);
  process.stdout.write(markdown);

  if (options.write) {
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const repositoryRoot = resolve(packageRoot, "../..");
    const directory = resolve(repositoryRoot, "artifacts/agent-runs");
    await mkdir(directory, { recursive: true });
    const stamp = createdAt.replace(/[:.]/gu, "-");
    const markdownPath = resolve(directory, `${stamp}.md`);
    const jsonPath = resolve(directory, `${stamp}.json`);
    await writeFile(markdownPath, markdown, "utf8");
    await writeFile(jsonPath, `${JSON.stringify({
      schemaVersion: 1,
      createdAt,
      scenario: demo.title,
      result,
    }, null, 2)}\n`, "utf8");
    process.stdout.write(`\nReports: ${markdownPath} and ${jsonPath}\n`);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await agentMain();
}
