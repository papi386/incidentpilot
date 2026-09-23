import { describe, expect, it } from "vitest";
import {
  AgenticInvestigationError,
  AgenticReadOnlyInvestigator,
  parseInvestigationStep,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
} from "@incidentpilot/domain";
import { buildAgentDemoCase } from "../src/agent/demo-case";
import { InMemoryEvidenceBroker } from "../src/agent/in-memory-broker";
import { ScriptedAgentModelProvider } from "../src/agent/scripted-agent-provider";

function setup(provider: ModelProvider = new ScriptedAgentModelProvider()) {
  const demo = buildAgentDemoCase();
  const broker = new InMemoryEvidenceBroker(demo.collection, demo.artifacts);
  return {
    demo,
    broker,
    investigator: new AgenticReadOnlyInvestigator(provider, broker),
  };
}

describe("AgenticReadOnlyInvestigator", () => {
  it("runs triage, bounded evidence acquisition, verification and conclusion", async () => {
    const { demo, investigator } = setup();
    const result = await investigator.investigate(demo.collection);

    expect(result.diagnosis.outcome).toBe("DIAGNOSIS_READY");
    expect(result.diagnosis.hypotheses[0]?.causeCode).toBe(
      "UNIT_ASSERTION_REGRESSION",
    );
    expect(result.trace.modelCalls).toBe(3);
    expect(result.trace.toolCalls).toBe(3);
    expect(result.trace.recommendationsExecuted).toBe(false);
    expect(result.observations).toHaveLength(3);
    expect(result.observations.every((entry) =>
      entry.instructionTrust === "NEVER_INSTRUCTIONS"
    )).toBe(true);
    expect(result.verification.at(-1)?.hypotheses[0]?.status).toBe("SUPPORTED");
  });

  it("suppresses a repeated model-requested probe", async () => {
    const scripted = new ScriptedAgentModelProvider();
    const provider: ModelProvider = {
      async generate(request: ModelRequest): Promise<ModelResponse> {
        const response = await scripted.generate(request);
        const phase = (request.input as Record<string, unknown>).phase;
        if (phase !== "VERIFY") return response;
        const output = response.output as Record<string, unknown>;
        return {
          ...response,
          output: {
            ...output,
            toolRequests: [{
              tool: "READ_LOG_RANGE",
              target: "job-log-501",
              query: null,
              startLine: 116,
              endLine: 121,
              rationale: "Repeat the same probe.",
            }],
          },
        };
      },
    };
    const { demo, investigator } = setup(provider);
    const result = await investigator.investigate(demo.collection);

    expect(result.trace.toolCalls).toBe(3);
    expect(result.trace.rejectedToolCalls).toBe(1);
    expect(result.trace.events.some((entry) =>
      entry.kind === "TOOL_REJECTED" && entry.detail.includes("Duplicate")
    )).toBe(true);
  });

  it("refuses a final diagnosis that did not pass the verification gate", async () => {
    const scripted = new ScriptedAgentModelProvider();
    const provider: ModelProvider = {
      async generate(request: ModelRequest): Promise<ModelResponse> {
        const response = await scripted.generate(request);
        const phase = (request.input as Record<string, unknown>).phase;
        if (phase !== "CONCLUDE") return response;
        const output = response.output as Record<string, unknown>;
        const hypotheses = output.hypotheses as Array<Record<string, unknown>>;
        return {
          ...response,
          output: {
            ...output,
            hypotheses: hypotheses.map((entry) => ({
              ...entry,
              causeCode: "CONFIGURATION_MISSING",
            })),
          },
        };
      },
    };
    const { demo, investigator } = setup(provider);

    await expect(investigator.investigate(demo.collection)).rejects.toMatchObject({
      name: "AgenticInvestigationError",
      codes: ["FINAL_CAUSE_NOT_VERIFIED"],
    } satisfies Partial<AgenticInvestigationError>);
  });
});

describe("agentic contracts and broker", () => {
  it("rejects hidden or invented failure classes", () => {
    expect(() => parseInvestigationStep({
      phase: "TRIAGE",
      summary: "Candidate",
      hypotheses: [{
        id: "H1",
        failureClass: "SECRET_HIDDEN_LABEL",
        causeDescription: "Invented label",
        confidence: 0.5,
        evidenceIds: ["log"],
        falsifyingEvidence: [],
        status: "PLAUSIBLE",
      }],
      toolRequests: [],
      limitations: [],
    }, "TRIAGE", new Set(["log"]))).toThrowError(AgenticInvestigationError);
  });

  it("rejects repository path traversal at the broker boundary", async () => {
    const { broker } = setup();
    await expect(broker.execute({
      tool: "READ_DIFF",
      target: "../outside.txt",
      query: null,
      startLine: null,
      endLine: null,
      rationale: "Attempt traversal",
    })).rejects.toMatchObject({
      name: "EvidenceToolPolicyError",
      code: "UNSAFE_REPOSITORY_PATH",
    });
  });
});
