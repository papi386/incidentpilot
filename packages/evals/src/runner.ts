import {
  DiagnosisValidationError,
  ReadOnlyInvestigator,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
} from "@incidentpilot/domain";
import {
  aggregateMetrics,
  estimateCost,
  evaluateSecurityGate,
  scoreCase,
} from "./scoring";
import { diagnoseOutputStructure } from "./output-diagnostics";
import type {
  CaseEvaluation,
  EvaluationCase,
  EvaluationReport,
  ModelAttemptObservation,
  TokenPricing,
} from "./types";

export type ModelProviderFactory = (
  testCase: EvaluationCase,
) => ModelProvider;

export interface EvaluationRunOptions {
  runKind: EvaluationReport["runKind"];
  pricing?: TokenPricing;
  timeoutMs?: number;
  modelIdHint?: string;
  now?: () => Date;
  runId?: string;
}

class ObservingProvider implements ModelProvider {
  output: unknown = null;
  readonly observation: ModelAttemptObservation;

  constructor(
    private readonly delegate: ModelProvider,
    modelIdHint?: string,
  ) {
    this.observation = {
      attempted: false,
      completed: false,
      modelId: modelIdHint ?? null,
      promptVersion: null,
      latencyMs: null,
      inputTokens: null,
      outputTokens: null,
      errorName: null,
    };
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    this.observation.attempted = true;
    const input = request.input !== null && typeof request.input === "object"
      ? request.input as Record<string, unknown>
      : null;
    this.observation.promptVersion = typeof input?.promptVersion === "string"
      ? input.promptVersion
      : null;
    const started = performance.now();

    try {
      const response = await this.delegate.generate(request);
      this.output = response.output;
      this.observation.completed = true;
      this.observation.modelId = response.modelId;
      this.observation.latencyMs = response.latencyMs;
      this.observation.inputTokens = response.inputTokens ?? null;
      this.observation.outputTokens = response.outputTokens ?? null;
      return response;
    } catch (error) {
      this.observation.latencyMs = Math.max(
        0,
        Math.round(performance.now() - started),
      );
      this.observation.errorName = error instanceof Error
        ? error.name
        : "UnknownError";
      throw error;
    }
  }
}

function errorCodes(error: unknown): string[] {
  if (error instanceof DiagnosisValidationError) return [...error.codes];
  if (error instanceof Error && error.name === "AbortError") {
    return ["MODEL_TIMEOUT"];
  }
  if (error instanceof Error) return [`INVESTIGATION_ERROR:${error.name}`];
  return ["INVESTIGATION_ERROR:UNKNOWN"];
}

export async function evaluateCase(
  testCase: EvaluationCase,
  provider: ModelProvider,
  pricing?: TokenPricing,
  timeoutMs = 60_000,
  modelIdHint?: string,
): Promise<CaseEvaluation> {
  const observing = new ObservingProvider(provider, modelIdHint);

  try {
    const result = await new ReadOnlyInvestigator(observing, timeoutMs).investigate(
      testCase.evidence,
    );

    return {
      caseId: testCase.caseId,
      category: testCase.category,
      title: testCase.title,
      result,
      observedOutput: observing.output,
      modelAttempt: observing.observation,
      outputStructure: diagnoseOutputStructure(observing.output),
      errorCodes: [],
      scores: scoreCase(
        testCase,
        result,
        observing.output,
        observing.observation.attempted,
      ),
      estimatedCostUsd: estimateCost(observing.observation, pricing),
    };
  } catch (error) {
    return {
      caseId: testCase.caseId,
      category: testCase.category,
      title: testCase.title,
      result: null,
      observedOutput: observing.output,
      modelAttempt: observing.observation,
      outputStructure: diagnoseOutputStructure(observing.output),
      errorCodes: errorCodes(error),
      scores: scoreCase(
        testCase,
        null,
        observing.output,
        observing.observation.attempted,
      ),
      estimatedCostUsd: estimateCost(observing.observation, pricing),
    };
  }
}

export async function evaluateSuite(
  cases: EvaluationCase[],
  providers: ModelProviderFactory,
  options: EvaluationRunOptions,
): Promise<EvaluationReport> {
  const evaluations: CaseEvaluation[] = [];

  // Deliberately sequential by default. Live evaluation should not turn a
  // local command into an uncontrolled burst against a model endpoint.
  for (const testCase of cases) {
    evaluations.push(
      await evaluateCase(
        testCase,
        providers(testCase),
        options.pricing,
        options.timeoutMs,
        options.modelIdHint,
      ),
    );
  }

  const metrics = aggregateMetrics(evaluations);
  const createdAt = (options.now ?? (() => new Date()))().toISOString();

  return {
    schemaVersion: 1,
    runId: options.runId ?? crypto.randomUUID(),
    runKind: options.runKind,
    createdAt,
    modelIds: [
      ...new Set(
        evaluations.flatMap((entry) =>
          entry.modelAttempt.modelId ? [entry.modelAttempt.modelId] : [],
        ),
      ),
    ].sort(),
    promptVersions: [
      ...new Set(
        evaluations.flatMap((entry) =>
          entry.result
            ? [entry.result.trace.promptVersion]
            : entry.modelAttempt.promptVersion
            ? [entry.modelAttempt.promptVersion]
            : [],
        ),
      ),
    ].sort(),
    metrics,
    securityGate: evaluateSecurityGate(metrics),
    cases: evaluations,
  };
}
