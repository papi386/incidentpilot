import { describe, expect, it } from "vitest";
import { extractFailureSignals } from "../src/evidence/failure-signals";

describe("extractFailureSignals", () => {
  it("extracts Python failing tests and stack frames", () => {
    const signals = extractFailureSignals([
      "FAILED tests/test_auth.py::test_refresh - AssertionError",
      "  File \"src/auth/service.py\", line 42, in refresh_token",
      "ValueError: expired token"
    ].join("\n"));

    expect(signals).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "FAILING_TEST" }),
      expect.objectContaining({ kind: "STACK_FRAME" }),
      expect.objectContaining({ kind: "ERROR_SIGNAL" })
    ]));
  });

  it("recognizes Python exception class names without standalone Error tokens", () => {
    const signals = extractFailureSignals([
      "ValueError: expired token",
      "requests.exceptions.ConnectionError: connection refused"
    ].join("\n"));

    expect(signals.filter((signal) => signal.kind === "ERROR_SIGNAL")).toHaveLength(2);
  });

  it("extracts Go test and source-frame signals", () => {
    const signals = extractFailureSignals([
      "--- FAIL: TestLeaseRenewal (0.00s)",
      "    internal/lease/worker.go:81: expected lease",
      "panic: invariant broken"
    ].join("\n"));

    expect(signals.some((signal) => signal.kind === "FAILING_TEST")).toBe(true);
    expect(signals.some((signal) => signal.kind === "STACK_FRAME")).toBe(true);
    expect(signals.some((signal) => signal.kind === "ERROR_SIGNAL")).toBe(true);
  });

  it("extracts JavaScript/TypeScript stack frames", () => {
    const signals = extractFailureSignals(
      "at parseConfig (src/config/parse.ts:17:9)\nError: invalid config"
    );
    const frame = signals.find((signal) => signal.kind === "STACK_FRAME");
    expect(frame?.value.path).toBe("src/config/parse.ts");
    expect(frame?.value.line).toBe(17);
  });
});
