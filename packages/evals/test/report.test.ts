import { describe, expect, it } from "vitest";
import { EVALUATION_CASES } from "../src/cases/catalog";
import { ScriptedModelProvider } from "../src/providers/scripted-provider";
import { markdownReport, persistenceSafeReport } from "../src/report";
import { evaluateSuite } from "../src/runner";

describe("evaluation reports", () => {
  it("labels scripted results and omits free-form model output from persistence", async () => {
    const testCase = EVALUATION_CASES[0]!;
    const report = await evaluateSuite(
      [testCase],
      () => new ScriptedModelProvider(testCase.referenceOutput),
      { runKind: "HARNESS_SELF_TEST", runId: "report-test" },
    );
    const markdown = markdownReport(report);
    const persisted = JSON.stringify(persistenceSafeReport(report));

    expect(markdown).toContain("not model or product performance");
    expect(markdown).toContain("COMPLETED");
    expect(markdown).toContain("JSON_OBJECT");
    expect(persisted).toContain("OMITTED_FROM_PERSISTED_REPORT");
    expect(persisted).toContain('"modelAttempt"');
    expect(persisted).toContain('"outputStructure"');
    expect(persisted).not.toContain(
      testCase.referenceOutput.hypotheses[0]!.explanation,
    );
  });
});
