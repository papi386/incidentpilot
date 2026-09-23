import { describe, expect, it, vi } from "vitest";
import type {
  ModelProvider,
  ModelRequest,
  ModelResponse,
} from "../src";
import {
  ModelCallsDisabledError,
  RuntimeGatedModelProvider,
} from "../src";

const request: ModelRequest = {
  role: "investigator",
  input: {},
  timeoutMs: 1_000,
};

function provider(): ModelProvider & {
  generate: ReturnType<typeof vi.fn<(request: ModelRequest) => Promise<ModelResponse>>>;
} {
  return {
    generate: vi.fn(async () => ({
      modelId: "test-model",
      output: {},
      latencyMs: 1,
    })),
  };
}

describe("RuntimeGatedModelProvider", () => {
  it("fails closed without calling the provider", async () => {
    const delegate = provider();
    const gated = new RuntimeGatedModelProvider(
      delegate,
      async () => false,
    );

    await expect(gated.generate(request)).rejects.toBeInstanceOf(
      ModelCallsDisabledError,
    );
    expect(delegate.generate).not.toHaveBeenCalled();
  });

  it("rechecks live authorization for every model request", async () => {
    const delegate = provider();
    let enabled = true;
    const authorize = vi.fn(async () => enabled);
    const gated = new RuntimeGatedModelProvider(delegate, authorize);

    await expect(gated.generate(request)).resolves.toMatchObject({
      modelId: "test-model",
    });

    enabled = false;
    await expect(gated.generate(request)).rejects.toBeInstanceOf(
      ModelCallsDisabledError,
    );

    expect(authorize).toHaveBeenCalledTimes(2);
    expect(delegate.generate).toHaveBeenCalledTimes(1);
  });
});
