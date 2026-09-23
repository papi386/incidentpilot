import { describe, expect, it } from "vitest";
import { GitHubIdentityProvider } from "../src/github/github-identity-provider";

describe("GitHubIdentityProvider", () => {
  it("creates an OAuth authorization URL with state and exact callback", () => {
    const provider = new GitHubIdentityProvider("client-123", "secret");
    const url = new URL(provider.authorizationUrl("state-456", "http://localhost:8787/auth/github/callback"));

    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("client-123");
    expect(url.searchParams.get("state")).toBe("state-456");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:8787/auth/github/callback");
  });

  it("exchanges a code, retrieves identity, and does not persist the access token itself", async () => {
    const responses = [
      new Response(JSON.stringify({ access_token: "temporary-user-token" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }),
      new Response(JSON.stringify({
        id: 42,
        login: "octocat",
        name: "The Octocat",
        avatar_url: "https://example.invalid/avatar.png"
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    ];

    const fetchMock: typeof fetch = async () => {
      const response = responses.shift();
      if (!response) throw new Error("unexpected fetch");
      return response;
    };

    const provider = new GitHubIdentityProvider("client", "secret", fetchMock);
    const result = await provider.exchangeCode("code", "http://localhost:8787/auth/github/callback");

    expect(result.accessToken).toBe("temporary-user-token");
    expect(result.identity).toMatchObject({
      provider: "github",
      externalUserId: "42",
      username: "octocat"
    });
  });

  it("normalizes installations returned by the authenticated-user endpoint", async () => {
    const fetchMock: typeof fetch = async () => new Response(JSON.stringify({
      installations: [{
        id: 9001,
        account: { id: 77, login: "example-org", type: "Organization" },
        repository_selection: "selected",
        permissions: { actions: "read", contents: "read" },
        suspended_at: null
      }]
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });

    const provider = new GitHubIdentityProvider("client", "secret", fetchMock);
    const installations = await provider.listInstallations("temporary-user-token");

    expect(installations).toEqual([{
      provider: "github",
      externalInstallationId: "9001",
      accountExternalId: "77",
      accountLogin: "example-org",
      accountType: "Organization",
      repositorySelection: "selected",
      permissions: { actions: "read", contents: "read" }
    }]);
  });
});
