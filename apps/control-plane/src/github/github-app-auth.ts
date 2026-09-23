import { readTextLimited, retryDelayFromHeaders } from "./github-api";
import { privateKeyPkcs8, PrivateKeyFormatError, type PrivateKeyFailure } from "./private-key";

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type GitHubReadPermission = "actions" | "checks" | "contents";

export interface InstallationTokenRequest {
  installationExternalId: string;
  repositoryExternalId: string;
  permissions: readonly GitHubReadPermission[];
}

export interface InstallationToken {
  token: string;
  expiresAt: string;
}

export class GitHubAuthError extends Error {
  constructor(
    public readonly code:
      | "INVALID_PRIVATE_KEY"
      | "INVALID_REPOSITORY_ID"
      | "INVALID_INSTALLATION_ID"
      | "TOKEN_REQUEST_FAILED"
      | "TOKEN_REQUEST_TIMEOUT"
      | "TOKEN_REQUEST_NETWORK_ERROR"
      | "TOKEN_RESPONSE_TOO_LARGE"
      | "TOKEN_RATE_LIMITED",
    message: string,
    public readonly status?: number,
    public readonly retryAfterMs?: number,
    public readonly privateKeyFailure?: PrivateKeyFailure
  ) {
    super(message);
    this.name = "GitHubAuthError";
  }
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/gu, "").replace(/\+/gu, "-").replace(/\//gu, "_");
}

function textToBase64Url(value: string): string {
  return bytesToBase64Url(new TextEncoder().encode(value));
}

function readPermissionMap(permissions: readonly GitHubReadPermission[]): Record<string, "read"> {
  return Object.fromEntries(permissions.map((permission) => [permission, "read"])) as Record<string, "read">;
}

function isRateLimited(response: Response): boolean {
  return response.status === 429
    || (response.status === 403 && (
      response.headers.has("Retry-After")
      || response.headers.get("X-RateLimit-Remaining") === "0"
    ));
}

export class GitHubAppTokenBroker {
  private readonly fetchImpl: FetchLike;
  private importedPrivateKey?: Promise<CryptoKey>;

  constructor(
    private readonly clientId: string,
    private readonly privateKeyPkcs8B64: string,
    fetchImpl?: FetchLike,
    private readonly timeoutMs = 8_000
  ) {
    // Wrapping native fetch avoids Workers' Illegal invocation this-binding trap.
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init));
  }

  private getPrivateKey(): Promise<CryptoKey> {
    if (!this.importedPrivateKey) {
      this.importedPrivateKey = Promise.resolve().then(() => crypto.subtle.importKey(
        "pkcs8",
        privateKeyPkcs8(this.privateKeyPkcs8B64),
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["sign"]
      )).catch((error: unknown) => {
        const reason = error instanceof PrivateKeyFormatError ? error.reason : "IMPORT";
        throw new GitHubAuthError("INVALID_PRIVATE_KEY", `GitHub App private key rejected (${reason})`, undefined, undefined, reason);
      });
    }
    return this.importedPrivateKey;
  }

  async createAppJwt(nowMs = Date.now()): Promise<string> {
    const nowSeconds = Math.floor(nowMs / 1000);
    const header = textToBase64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = textToBase64Url(JSON.stringify({
      iat: nowSeconds - 60,
      exp: nowSeconds + (9 * 60),
      iss: this.clientId
    }));

    const signingInput = `${header}.${payload}`;
    const key = await this.getPrivateKey();
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      key,
      new TextEncoder().encode(signingInput)
    );
    return `${signingInput}.${bytesToBase64Url(new Uint8Array(signature))}`;
  }

  async createInstallationToken(request: InstallationTokenRequest): Promise<InstallationToken> {
    const repositoryId = Number(request.repositoryExternalId);
    if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) {
      throw new GitHubAuthError("INVALID_REPOSITORY_ID", "GitHub repository ID is not a safe positive integer");
    }

    const installationId = Number(request.installationExternalId);
    if (!Number.isSafeInteger(installationId) || installationId <= 0) {
      throw new GitHubAuthError("INVALID_INSTALLATION_ID", "GitHub installation ID is not a safe positive integer");
    }

    const jwt = await this.createAppJwt();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new DOMException("The operation was aborted", "AbortError"));
      }, this.timeoutMs);
    });

    let body: { token?: unknown; expires_at?: unknown };
    try {
      body = await Promise.race([
        (async (): Promise<{ token?: unknown; expires_at?: unknown }> => {
          const response = await this.fetchImpl(
        `https://api.github.com/app/installations/${installationId}/access_tokens`,
        {
          method: "POST",
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${jwt}`,
            "Content-Type": "application/json",
            "User-Agent": "IncidentPilot",
            "X-GitHub-Api-Version": "2026-03-10"
          },
          body: JSON.stringify({
            repository_ids: [repositoryId],
            permissions: readPermissionMap(request.permissions)
          }),
          signal: controller.signal
        }
      );

      if (!response.ok) {
        if (isRateLimited(response)) {
          throw new GitHubAuthError(
            "TOKEN_RATE_LIMITED",
            "GitHub installation token request was rate limited",
            response.status,
            retryDelayFromHeaders(response.headers)
          );
        }
        throw new GitHubAuthError(
          "TOKEN_REQUEST_FAILED",
          `GitHub installation token request failed with status ${response.status}`,
          response.status
        );
      }

      // The same deadline covers both response headers and body consumption.
      const limited = await readTextLimited(response, 64 * 1024);
      if (limited.truncated) {
        throw new GitHubAuthError("TOKEN_RESPONSE_TOO_LARGE", "GitHub installation token response exceeded the size limit", 502);
      }

          try {
            return JSON.parse(limited.text) as { token?: unknown; expires_at?: unknown };
          } catch {
            throw new GitHubAuthError("TOKEN_REQUEST_FAILED", "GitHub installation token response was malformed", 502);
          }
        })(),
        deadline
      ]);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new GitHubAuthError("TOKEN_REQUEST_TIMEOUT", "GitHub installation token request timed out");
      }
      if (error instanceof TypeError) {
        throw new GitHubAuthError("TOKEN_REQUEST_NETWORK_ERROR", "GitHub installation token request failed at the network layer");
      }
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (typeof body.token !== "string" || typeof body.expires_at !== "string") {
      throw new GitHubAuthError("TOKEN_REQUEST_FAILED", "GitHub installation token response was malformed", 502);
    }

    return { token: body.token, expiresAt: body.expires_at };
  }
}
