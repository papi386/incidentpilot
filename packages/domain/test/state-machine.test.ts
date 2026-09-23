import { describe, expect, it } from "vitest";
import { assertTransition, canTransition } from "../src/state-machine";

describe("incident state machine", () => {
  it("allows the trusted V1 startup path", () => {
    expect(canTransition("RECEIVED", "VALIDATING")).toBe(true);
    expect(canTransition("VALIDATING", "AUTHORIZED")).toBe(true);
    expect(canTransition("AUTHORIZED", "TRIAGING")).toBe(true);
  });

  it("rejects jumping directly from received to completed", () => {
    expect(() => assertTransition("RECEIVED", "COMPLETED")).toThrow(/Illegal incident status transition/);
  });
});
