import { describe, expect, it } from "vitest";
import { GitHubApiClient } from "../src/github/github-api";

describe("GitHub request options in Workers", () => {
  it("constructs the API request using the native Workers Request", async () => {
    const client = new GitHubApiClient("test-token", async (url, init) => {
      // Unlike a response-only mock, exercise the runtime's Request validation.
      const request = new Request(url, init);
      expect(request.redirect).toBe("manual");
      return Response.json({ id: 123 });
    });
    await expect(client.getJson("/repos/test/repo/actions/runs/123")).resolves.toEqual({ id: 123 });
  });

  it("constructs both log requests and omits the bearer on the download", async () => {
    const requests: Request[] = [];
    const client = new GitHubApiClient("test-token", async (url, init) => {
      const request = new Request(url, init);
      requests.push(request);
      expect(request.redirect).toBe("manual");
      return requests.length === 1
        ? new Response(null, { status: 302, headers: { Location: "https://pipelines.actions.githubusercontent.com/log" } })
        : new Response("failure details");
    });
    await expect(client.getJobLog("/repos/test/repo/actions/jobs/123/logs", 1024)).resolves.toMatchObject({ text: "failure details" });
    expect(requests).toHaveLength(2);
    expect(requests[0]!.headers.get("Authorization")).toBe("Bearer test-token");
    expect(requests[1]!.headers.has("Authorization")).toBe(false);
  });

  it.each([301, 302, 303, 307, 308])("blocks API redirect %i without a second request", async (status) => {
    let calls = 0;
    const client = new GitHubApiClient("test-token", async (url, init) => {
      new Request(url, init);
      calls++;
      return new Response(null, { status, headers: { Location: "https://other.invalid/" } });
    });
    await expect(client.getJson("/repos/test/repo/actions/runs/123")).rejects.toMatchObject({ code: "UNEXPECTED_REDIRECT" });
    expect(calls).toBe(1);
  });

  it("blocks redirect chaining from the approved log host", async () => {
    let calls = 0;
    const client = new GitHubApiClient("test-token", async (url, init) => {
      new Request(url, init);
      calls++;
      return new Response(null, { status: 302, headers: {
        Location: calls === 1 ? "https://pipelines.actions.githubusercontent.com/log" : "https://other.invalid/"
      } });
    });
    await expect(client.getJobLog("/jobs/123/logs", 1024)).rejects.toMatchObject({ code: "UNEXPECTED_REDIRECT" });
    expect(calls).toBe(2);
  });
});
