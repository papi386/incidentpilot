import { describe, expect, it } from "vitest";
import { readRequestBodyLimited, RequestBodyError } from "../src/security/request-body";

describe("bounded request body", () => {
  it("reads within the limit", async () => {
    const result = await readRequestBodyLimited(new Request("https://x", { method: "POST", body: "abc" }), 3);
    expect(new TextDecoder().decode(result)).toBe("abc");
  });
  it("rejects oversized bodies", async () => {
    await expect(readRequestBodyLimited(new Request("https://x", { method: "POST", body: "abcd" }), 3))
      .rejects.toBeInstanceOf(RequestBodyError);
  });
});
