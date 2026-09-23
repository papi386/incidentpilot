import type {
  ModelProvider,
  ModelRequest,
  ModelResponse,
} from "./ports";

export type ModelCallAuthorization = () => Promise<boolean>;

export class ModelCallsDisabledError extends Error {
  readonly code = "MODEL_CALLS_DISABLED";

  constructor() {
    super("Model calls are disabled by runtime policy");
    this.name = "ModelCallsDisabledError";
  }
}

/**
 * Fail-closed model boundary shared by evaluation and future runtime wiring.
 *
 * The authorization callback is evaluated for every request. A caller can
 * therefore bind it to the live D1 `model_calls_enabled` control without
 * caching a stale decision across retries or a long-running workflow.
 */
export class RuntimeGatedModelProvider implements ModelProvider {
  constructor(
    private readonly delegate: ModelProvider,
    private readonly authorize: ModelCallAuthorization,
  ) {}

  async generate(request: ModelRequest): Promise<ModelResponse> {
    if (!(await this.authorize())) {
      throw new ModelCallsDisabledError();
    }

    return this.delegate.generate(request);
  }
}
