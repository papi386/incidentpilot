import { describe, expect, it, vi } from "vitest";
import { OpenAiCompatibleModelProvider } from "../src/providers/openai-compatible-provider";

function provider(fetchImplementation: typeof fetch) {
  return new OpenAiCompatibleModelProvider({
    baseUrl: "https://models.example.test/v1",
    apiKey: "test-key",
    model: "test-model",
    fetch: fetchImplementation,
    maximumRequestBytes: 4_096,
    maximumResponseBytes: 4_096,
  });
}

describe("OpenAiCompatibleModelProvider", () => {
  it("uses bounded JSON mode without exposing credentials in the body", async () => {
    const request = vi.fn<typeof fetch>(async (_input, init) => {
      const body = String(init?.body);
      expect(body).not.toContain("test-key");
      expect(JSON.parse(body)).toMatchObject({
        model: "test-model",
        temperature: 0,
        response_format: { type: "json_object" },
      });

      return new Response(JSON.stringify({
        model: "served-model",
        choices: [{ message: { content: '{"outcome":"NEEDS_HUMAN"}' } }],
        usage: { prompt_tokens: 12, completion_tokens: 4 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const result = await provider(request).generate({
      role: "investigator",
      input: { evidence: [] },
      timeoutMs: 1_000,
    });

    expect(result).toMatchObject({
      modelId: "served-model",
      output: '{"outcome":"NEEDS_HUMAN"}',
      inputTokens: 12,
      outputTokens: 4,
    });
  });

  it("uses provider-level JSON Schema constraints for an agent phase", async () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["phase"],
      properties: { phase: { type: "string", enum: ["VERIFY"] } },
    };
    const request = vi.fn<typeof fetch>(async (_input, init) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "incidentpilot_verify",
            strict: true,
            schema,
          },
        },
      });
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"phase":"VERIFY"}' } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    await provider(request).generate({
      role: "critic",
      input: {
        runtimeVersion: "incidentpilot-evidence-agent-v1",
        phase: "VERIFY",
        outputContract: schema,
      },
      timeoutMs: 1_000,
    });

    expect(request).toHaveBeenCalledOnce();
  });

  it("rejects redirects instead of forwarding an authorization header", async () => {
    const request = vi.fn<typeof fetch>(async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://attacker.invalid" },
      })
    );

    await expect(provider(request).generate({
      role: "investigator",
      input: {},
      timeoutMs: 1_000,
    })).rejects.toThrow(/redirect rejected/u);
  });

  it("rejects an oversized response", async () => {
    const request = vi.fn<typeof fetch>(async () =>
      new Response("x".repeat(5_000), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    await expect(provider(request).generate({
      role: "investigator",
      input: {},
      timeoutMs: 1_000,
    })).rejects.toThrow(/exceeds byte limit/u);
  });

  it("rejects an oversized request before contacting the endpoint", async () => {
    const request = vi.fn<typeof fetch>();

    await expect(provider(request).generate({
      role: "investigator",
      input: { evidence: "x".repeat(10_000) },
      timeoutMs: 1_000,
    })).rejects.toThrow(/request exceeds byte limit/u);

    expect(request).not.toHaveBeenCalled();
  });

  it("rejects a successful non-JSON response", async () => {
    const request = vi.fn<typeof fetch>(async () =>
      new Response("ok", {
        status: 200,
        headers: { "content-type": "text/plain" },
      })
    );

    await expect(provider(request).generate({
      role: "investigator",
      input: {},
      timeoutMs: 1_000,
    })).rejects.toThrow(/non-JSON/u);
  });

  it("allows HTTP only for a local evaluation endpoint", () => {
    expect(() => new OpenAiCompatibleModelProvider({
      baseUrl: "http://models.example.test/v1",
      apiKey: "x",
      model: "x",
    })).toThrow(/must use HTTPS/u);

    expect(() => new OpenAiCompatibleModelProvider({
      baseUrl: "http://localhost:11434/v1",
      apiKey: "local",
      model: "local",
    })).not.toThrow();
  });
});
