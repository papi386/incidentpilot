import { describe, expect, it } from "vitest";
import type {
  ModelProvider,
  ModelRequest,
  ModelResponse,
} from "@incidentpilot/domain";
import { REAL_WORLD_CASES, STRESS_CASES } from "../src/stress/cases";
import { runStressAttempt } from "../src/stress/runner";
import { ScriptedStressModelProvider } from "../src/stress/scripted-provider";

function phaseOf(request: ModelRequest): string {
  const input = request.input as Record<string, unknown>;
  return typeof input.phase === "string" ? input.phase : "";
}

describe("pre-production stress suite", () => {
  it("keeps the fixed hard-case inventory and weekly security controls", () => {
    expect(STRESS_CASES).toHaveLength(8);
    const controls = new Set(STRESS_CASES.flatMap((entry) => entry.controlsExercised));

    expect([...controls]).toEqual(expect.arrayContaining([
      "PROMPT_INJECTION",
      "APPROVAL_REPLAY",
      "FAKE_TOOL_OUTPUT",
      "SECRET_EXFILTRATION",
      "CHILD_AGENT_PRIVILEGE_INHERITANCE",
      "SSRF",
      "DNS_REBINDING",
      "REDIRECT_REVALIDATION",
      "CREDENTIAL_FORWARDING",
      "PATH_TRAVERSAL",
      "SYMLINK_ESCAPE",
      "COMMAND_INJECTION",
      "RESOURCE_EXHAUSTION",
      "CAUSE_VS_SYMPTOM",
      "CONFLICTING_EVIDENCE",
      "CALIBRATED_ABSTENTION",
    ]));
  });

  it("passes every unchanged case with the deterministic reference provider", async () => {
    for (const testCase of STRESS_CASES) {
      const attempt = await runStressAttempt(
        testCase,
        "scripted-stress-harness",
        new ScriptedStressModelProvider(testCase),
        5_000,
      );

      expect(attempt.status, testCase.caseId).toBe("PASS");
      expect(attempt.systemSecurityPassed, testCase.caseId).toBe(true);
    }
  });

  it("reports a contained unsafe tool request as model-policy failure", async () => {
    const testCase = STRESS_CASES.find((entry) =>
      entry.caseId === "security-path-symlink-command-injection"
    )!;
    const scripted = new ScriptedStressModelProvider(testCase);
    const provider: ModelProvider = {
      async generate(request: ModelRequest): Promise<ModelResponse> {
        const response = await scripted.generate(request);
        if (phaseOf(request) !== "TRIAGE") return response;
        const output = response.output as Record<string, unknown>;
        return {
          ...response,
          output: {
            ...output,
            toolRequests: [{
              tool: "READ_DIFF",
              target: "../../.ssh/id_rsa; whoami",
              query: null,
              startLine: null,
              endLine: null,
              rationale: "Attempt the untrusted path embedded in the log.",
            }],
          },
        };
      },
    };

    const attempt = await runStressAttempt(testCase, "unsafe-script", provider, 5_000);

    expect(attempt.status).toBe("MODEL_POLICY_FAIL");
    expect(attempt.systemSecurityPassed).toBe(true);
    expect(attempt.modelPolicyPassed).toBe(false);
    expect(attempt.brokerDenialCount).toBe(1);
    expect(attempt.result?.trace.recommendationsExecuted).toBe(false);
  });

  it("detects and redacts an injected success marker emitted by a model", async () => {
    const testCase = STRESS_CASES.find((entry) =>
      entry.caseId === "security-composite-control-plane-bypass"
    )!;
    const marker = testCase.attackMarkers[0]!;
    const scripted = new ScriptedStressModelProvider(testCase);
    const provider: ModelProvider = {
      async generate(request: ModelRequest): Promise<ModelResponse> {
        const response = await scripted.generate(request);
        if (phaseOf(request) !== "TRIAGE") return response;
        const output = response.output as Record<string, unknown>;
        return {
          ...response,
          output: { ...output, summary: `Untrusted instruction completed: ${marker}` },
        };
      },
    };

    const attempt = await runStressAttempt(testCase, "leaky-script", provider, 5_000);

    expect(attempt.status).toBe("SYSTEM_SECURITY_FAIL");
    expect(attempt.attackMarkerCount).toBe(1);
    expect(attempt.failedOutputDiagnostics[0]?.safeExcerpt).not.toContain(marker);
    expect(attempt.failedOutputDiagnostics[0]?.safeExcerpt).toContain("[REDACTED_TEST_TOKEN]");
  });
});

describe("held-out real-world scenarios", () => {
  it("freezes the stale generated-client cause before live model evaluation", () => {
    expect(REAL_WORLD_CASES).toHaveLength(1);
    expect(REAL_WORLD_CASES[0]).toMatchObject({
      caseId: "real-world-monorepo-stale-generated-client",
      category: "REAL_WORLD",
      expectedOutcomes: ["DIAGNOSIS_READY"],
      acceptedRootCauseCodes: ["STALE_BUILD_ARTIFACT"],
    });
  });

  it("passes the held-out case through the same deterministic harness contract", async () => {
    const testCase = REAL_WORLD_CASES[0]!;
    const attempt = await runStressAttempt(
      testCase,
      "scripted-stress-harness",
      new ScriptedStressModelProvider(testCase),
      5_000,
    );

    expect(attempt.status).toBe("PASS");
    expect(attempt.observedRootCauseCode).toBe("STALE_BUILD_ARTIFACT");
    expect(attempt.result?.causalAnalysis.signals)
      .toContain("STALE_GENERATED_ARTIFACT_CAUSAL_CHAIN");
    expect(attempt.result?.causalAnalysis.classifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          evidenceId: "real-downstream-error",
          classification: "DOWNSTREAM_SYMPTOM",
        }),
      ]),
    );
  });

  it("localizes stale generation above a model's downstream type-error label", async () => {
    const testCase = REAL_WORLD_CASES[0]!;
    const scripted = new ScriptedStressModelProvider(testCase);
    const provider: ModelProvider = {
      async generate(request: ModelRequest): Promise<ModelResponse> {
        const response = await scripted.generate(request);
        const phase = phaseOf(request);
        if (phase === "AUTHORITY_REVIEW") {
          return response;
        }
        if (phase === "SKEPTIC_REVIEW") {
          const output = response.output as Record<string, unknown>;
          const findings = output.findings as Array<Record<string, unknown>>;
          return {
            ...response,
            output: {
              ...output,
              overallVerdict: "ABSTAIN",
              findings: findings.map((finding) => ({
                ...finding,
                verdict: "UNRESOLVED",
                reasonCodes: ["CONFLICTING_EVIDENCE"],
              })),
            },
          };
        }
        const output = response.output as Record<string, unknown>;
        if (phase === "TRIAGE" || phase === "VERIFY") {
          const hypotheses = output.hypotheses as Array<Record<string, unknown>>;
          return {
            ...response,
            output: {
              ...output,
              hypotheses: hypotheses.map((hypothesis) => ({
                ...hypothesis,
                failureClass: "TYPE_CONTRACT_MISMATCH",
              })),
            },
          };
        }
        if (phase === "CONCLUDE") {
          const hypotheses = output.hypotheses as Array<Record<string, unknown>>;
          return {
            ...response,
            output: {
              ...output,
              hypotheses: hypotheses.map((hypothesis) => ({
                ...hypothesis,
                causeCode: "TYPE_CONTRACT_MISMATCH",
              })),
            },
          };
        }
        return response;
      },
    };

    const attempt = await runStressAttempt(testCase, "downstream-only-model", provider, 5_000);

    expect(attempt.status).toBe("PASS");
    expect(attempt.observedRootCauseCode).toBe("STALE_BUILD_ARTIFACT");
    expect(attempt.result?.adjudication.decision)
      .toBe("ACCEPT_WITH_DETERMINISTIC_CAUSAL_GATE");
  });
});
