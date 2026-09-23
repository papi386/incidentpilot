import type {
  DiagnosisOutcome,
  EvidenceCollectionResult,
  ExecutionCapability,
  InvestigationResult,
  ReadOnlyDiagnosis,
} from "@incidentpilot/domain";

export type EvaluationCategory =
  | "CORRECTNESS"
  | "AMBIGUOUS"
  | "INSUFFICIENT_EVIDENCE"
  | "CONFLICTING_EVIDENCE"
  | "ADVERSARIAL";

export interface EvaluationExpectation {
  outcomes: DiagnosisOutcome[];
  acceptedRootCauseCodes: string[];
  requiredEvidenceIds: string[];
  relevantEvidenceIds: string[];
  allowedCapabilities: ExecutionCapability[];
  expectModelCall: boolean;
}

export interface EvaluationSecurityExpectation {
  forbiddenOutputSubstrings: string[];
  canarySecrets: string[];
  attackSuccessMarkers: string[];
}

export interface EvaluationCase {
  caseId: string;
  category: EvaluationCategory;
  title: string;
  evidence: EvidenceCollectionResult;
  expected: EvaluationExpectation;
  security: EvaluationSecurityExpectation;
  /**
   * Used only by the harness self-test. It is a fixture, never a claim about
   * real model performance.
   */
  referenceOutput: ReadOnlyDiagnosis;
}

export interface TokenPricing {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
}

export interface CaseScores {
  schemaValid: boolean;
  expectedOutcome: boolean;
  expectedModelCall: boolean;
  rootCauseTop1: boolean | null;
  rootCauseTop3: boolean | null;
  top1Confidence: number | null;
  evidencePrecision: number | null;
  requiredEvidenceRecall: number | null;
  abstentionCorrect: boolean | null;
  unknownCitationCount: number;
  unauthorizedActionCount: number;
  irrelevantRecommendationCount: number;
  forbiddenClaimCount: number;
  secretLeakageCount: number;
  successfulInjectionCount: number;
}

export interface ModelAttemptObservation {
  attempted: boolean;
  completed: boolean;
  modelId: string | null;
  promptVersion: string | null;
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  errorName: string | null;
}

export type OutputEnvelope =
  | "NO_OUTPUT"
  | "JSON_OBJECT"
  | "JSON_ARRAY"
  | "JSON_PRIMITIVE"
  | "NON_JSON_STRING"
  | "NON_JSON_VALUE";

export interface OutputStructureDiagnostics {
  envelope: OutputEnvelope;
  recognizedFields: string[];
  missingRequiredFields: string[];
  unexpectedFieldCount: number;
  fieldTypes: Record<string, string>;
}

export interface CaseEvaluation {
  caseId: string;
  category: EvaluationCategory;
  title: string;
  result: InvestigationResult | null;
  observedOutput: unknown;
  modelAttempt: ModelAttemptObservation;
  outputStructure: OutputStructureDiagnostics;
  errorCodes: string[];
  scores: CaseScores;
  estimatedCostUsd: number | null;
}

export interface AggregateMetrics {
  cases: number;
  modelCalls: number;
  schemaValidityRate: number;
  expectedOutcomeRate: number;
  expectedModelCallRate: number;
  rootCauseTop1Accuracy: number | null;
  rootCauseTop3Accuracy: number | null;
  meanBrierScore: number | null;
  expectedCalibrationError: number | null;
  meanEvidencePrecision: number | null;
  meanRequiredEvidenceRecall: number | null;
  abstentionRecall: number | null;
  unknownCitationCount: number;
  unauthorizedActionCount: number;
  irrelevantRecommendationCount: number;
  forbiddenClaimCount: number;
  secretLeakageCount: number;
  successfulInjectionCount: number;
  meanLatencyMs: number | null;
  p95LatencyMs: number | null;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number | null;
}

export interface SecurityGateResult {
  passed: boolean;
  failures: string[];
}

export interface EvaluationReport {
  schemaVersion: 1;
  runId: string;
  runKind: "HARNESS_SELF_TEST" | "LIVE_MODEL_EVALUATION";
  createdAt: string;
  modelIds: string[];
  promptVersions: string[];
  metrics: AggregateMetrics;
  securityGate: SecurityGateResult;
  cases: CaseEvaluation[];
}
