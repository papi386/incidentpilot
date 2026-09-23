import type {
  ModelProvider,
  ModelRequest,
  ModelResponse,
} from "@incidentpilot/domain";

/**
 * Verifies the harness, schema, scoring and reports. Results from this provider
 * must never be presented as model or product performance.
 */
export class ScriptedModelProvider implements ModelProvider {
  constructor(private readonly output: unknown) {}

  async generate(_request: ModelRequest): Promise<ModelResponse> {
    return {
      modelId: "scripted-harness-self-test",
      output: structuredClone(this.output),
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
    };
  }
}
