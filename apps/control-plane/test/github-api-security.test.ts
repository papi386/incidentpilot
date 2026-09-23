import { describe, expect, it } from "vitest";
import { GitHubApiClient, GitHubApiError, GitHubSecurityValidationError, isSafeGitHubDownloadRedirect, readTextLimited } from "../src/github/github-api";

describe("GitHub API download security", () => {
  it("allows ordinary HTTPS signed download locations", () => {
    expect(isSafeGitHubDownloadRedirect("https://pipelines.actions.githubusercontent.com/a/b?sig=x")).toBe(true);
    expect(isSafeGitHubDownloadRedirect("https://productionresultssa1.blob.core.windows.net/actions-results/log.txt?sig=x")).toBe(true);
  });

  it("rejects downgrade, credentials, local hosts, IP literals, and custom ports", () => {
    expect(isSafeGitHubDownloadRedirect("http://example.com/log")).toBe(false);
    expect(isSafeGitHubDownloadRedirect("https://user:pass@example.com/log")).toBe(false);
    expect(isSafeGitHubDownloadRedirect("https://localhost/log")).toBe(false);
    expect(isSafeGitHubDownloadRedirect("https://127.0.0.1/log")).toBe(false);
    expect(isSafeGitHubDownloadRedirect("https://example.com:8443/log")).toBe(false);
    expect(isSafeGitHubDownloadRedirect("https://evil.example/log")).toBe(false);
  });

  it("stops reading after the configured byte ceiling", async () => {
    const response = new Response("x".repeat(100));
    const result = await readTextLimited(response, 16);
    expect(result.bytesRead).toBe(16);
    expect(result.text.length).toBe(16);
    expect(result.truncated).toBe(true);
  });

  it("rejects oversized JSON before parsing it", async () => {
    const client = new GitHubApiClient(
      "test-token",
      async () => new Response(JSON.stringify({ value: "x".repeat(200) }))
    );

    await expect(client.getJson("/test", 32)).rejects.toMatchObject({
      name: "GitHubApiError",
      code: "RESPONSE_TOO_LARGE",
      status: 413
    } satisfies Partial<GitHubApiError>);
  });
  it("keeps the deadline active while the response body is streaming", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"value":"'));
        setTimeout(() => {
          controller.enqueue(new TextEncoder().encode('late"}'));
          controller.close();
        }, 75);
      }
    });
    const client = new GitHubApiClient("test-token", async () => new Response(stream), 10);
    await expect(client.getJson("/slow", 1024)).rejects.toMatchObject({ code: "NETWORK_TIMEOUT" });
  });

  it("classifies unsafe redirects as local security validation failures", async () => {
    const client = new GitHubApiClient("test-token", async () => new Response(null, {
      status: 302,
      headers: { Location: "https://127.0.0.1/private" }
    }));
    await expect(client.getJobLog("/jobs/1/logs", 1024)).rejects.toBeInstanceOf(GitHubSecurityValidationError);
  });

});
