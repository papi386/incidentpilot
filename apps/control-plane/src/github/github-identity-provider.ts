import type {
  IdentityAuthorizationResult,
  IdentityProvider,
  IntegrationInstallation
} from "@incidentpilot/domain";

const API_VERSION = "2026-03-10";

interface GitHubTokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

interface GitHubUserResponse {
  id?: number;
  login?: string;
  name?: string | null;
  avatar_url?: string | null;
}

interface GitHubInstallationResponse {
  id?: number;
  account?: {
    id?: number;
    login?: string;
    type?: string;
  } | null;
  target_type?: string;
  repository_selection?: string;
  permissions?: Record<string, string>;
  suspended_at?: string | null;
}

interface GitHubInstallationsPage {
  installations?: GitHubInstallationResponse[];
}

type FetchLike =
  (input: string | URL, init?: RequestInit) =>
    Promise<Response>;

export class GitHubIdentityProvider
  implements IdentityProvider {

  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    fetchImpl?: FetchLike
  ) {
    this.fetchImpl =
      fetchImpl ??
      ((input, init) => fetch(input, init));
  }

  authorizationUrl(state: string, redirectUri: string): string {
    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    return url.toString();
  }

  async exchangeCode(code: string, redirectUri: string): Promise<IdentityAuthorizationResult> {
    const tokenResponse = await this.fetchImpl("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "IncidentPilot"
      },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        code,
        redirect_uri: redirectUri
      })
    });

    if (!tokenResponse.ok) {
      throw new Error(`GitHub OAuth token exchange failed (${tokenResponse.status})`);
    }

    const tokenPayload = await tokenResponse.json() as GitHubTokenResponse;
    if (!tokenPayload.access_token) {
      throw new Error(`GitHub OAuth token exchange rejected: ${tokenPayload.error ?? "unknown_error"}`);
    }

    const accessToken = tokenPayload.access_token;
    const userResponse = await this.fetchImpl("https://api.github.com/user", {
      headers: this.apiHeaders(accessToken)
    });

    if (!userResponse.ok) {
      throw new Error(`GitHub user lookup failed (${userResponse.status})`);
    }

    const user = await userResponse.json() as GitHubUserResponse;
    if (user.id === undefined || !user.login) {
      throw new Error("GitHub user response missing required identity fields");
    }

    return {
      accessToken,
      identity: {
        provider: "github",
        externalUserId: String(user.id),
        username: user.login,
        ...(typeof user.name === "string" && user.name.length > 0
          ? { displayName: user.name }
          : {}),
        ...(typeof user.avatar_url === "string" && user.avatar_url.length > 0
          ? { avatarUrl: user.avatar_url }
          : {})
      }
    };
  }

  async listInstallations(accessToken: string): Promise<IntegrationInstallation[]> {
    const installations: IntegrationInstallation[] = [];

    // Bound pagination so one login cannot become an unbounded GitHub API loop.
    for (let page = 1; page <= 5; page += 1) {
      const url = new URL("https://api.github.com/user/installations");
      url.searchParams.set("per_page", "100");
      url.searchParams.set("page", String(page));

      const response = await this.fetchImpl(url.toString(), {
        headers: this.apiHeaders(accessToken)
      });

      if (!response.ok) {
        throw new Error(`GitHub installation lookup failed (${response.status})`);
      }

      const payload = await response.json() as GitHubInstallationsPage;
      const pageItems = payload.installations ?? [];

      for (const installation of pageItems) {
        const account = installation.account;
        if (
          installation.id === undefined ||
          account?.id === undefined ||
          !account.login
        ) {
          continue;
        }

        installations.push({
          provider: "github",
          externalInstallationId: String(installation.id),
          accountExternalId: String(account.id),
          accountLogin: account.login,
          accountType: account.type ?? installation.target_type ?? "Unknown",
          repositorySelection: installation.repository_selection ?? "unknown",
          permissions: installation.permissions ?? {},
          ...(typeof installation.suspended_at === "string"
            ? { suspendedAt: installation.suspended_at }
            : {})
        });
      }

      if (pageItems.length < 100) break;
    }

    return installations;
  }

  private apiHeaders(accessToken: string): HeadersInit {
    return {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${accessToken}`,
      "X-GitHub-Api-Version": API_VERSION,
      "User-Agent": "IncidentPilot"
    };
  }
}
