type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
type TokenRefresher = () => Promise<string>;

const LOG_REDIRECT_HOSTS = [
  "results-receiver.actions.githubusercontent.com"
] as const;
const LOG_REDIRECT_SUFFIXES = [
  ".actions.githubusercontent.com",
  ".blob.core.windows.net"
] as const;

export class GitHubApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    public readonly requestId?: string,
    public readonly retryAfterMs?: number
  ) {
    super(`GitHub API request failed (${code}, status=${status})`);
    this.name = "GitHubApiError";
  }
}

export class GitHubSecurityValidationError extends Error {
  constructor(public readonly code: "UNSAFE_LOG_REDIRECT" | "UNEXPECTED_REDIRECT", message: string) {
    super(message);
    this.name = "GitHubSecurityValidationError";
  }
}

export interface LimitedTextResult {
  text: string;
  bytesRead: number;
  truncated: boolean;
}

export function retryDelayFromHeaders(headers: Headers, nowMs = Date.now()): number | undefined {
  const retryAfter = headers.get("Retry-After");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
    const dateMs = Date.parse(retryAfter);
    if (Number.isFinite(dateMs)) return Math.max(0, dateMs - nowMs);
  }

  const reset = headers.get("X-RateLimit-Reset");
  if (reset) {
    const epochSeconds = Number(reset);
    if (Number.isFinite(epochSeconds) && epochSeconds > 0) {
      return Math.max(0, Math.ceil(epochSeconds * 1000 - nowMs));
    }
  }
  return undefined;
}

function rateLimited(response: Response): boolean {
  return response.status === 429
    || (response.status === 403 && (
      response.headers.has("Retry-After")
      || response.headers.get("X-RateLimit-Remaining") === "0"
    ));
}

async function withRequestDeadline<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new DOMException("The operation was aborted", "AbortError"));
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation(controller.signal), deadline]);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new GitHubApiError("NETWORK_TIMEOUT", 504);
    }
    if (error instanceof TypeError) {
      throw new GitHubApiError("NETWORK_ERROR", 503);
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}


export function isSafeGitHubDownloadRedirect(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    if (url.username || url.password) return false;
    if (url.port && url.port !== "443") return false;

    const hostname = url.hostname.toLowerCase();
    if (hostname === "localhost" || hostname.endsWith(".localhost")) return false;
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(hostname)) return false;
    if (hostname === "::1" || hostname.startsWith("[")) return false;

    return LOG_REDIRECT_HOSTS.includes(hostname as (typeof LOG_REDIRECT_HOSTS)[number])
      || LOG_REDIRECT_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
  } catch {
    return false;
  }
}


export async function readTextLimited(response: Response, maxBytes: number): Promise<LimitedTextResult> {
  if (!response.body) return { text: "", bytesRead: 0, truncated: false };

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let bytesRead = 0;
  let truncated = false;
  let text = "";

  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;

      const remaining = maxBytes - bytesRead;
      if (remaining <= 0) {
        truncated = true;
        await reader.cancel();
        break;
      }

      const selected = chunk.value.byteLength > remaining
        ? chunk.value.slice(0, remaining)
        : chunk.value;
      bytesRead += selected.byteLength;
      text += decoder.decode(selected, { stream: true });

      if (chunk.value.byteLength > remaining) {
        truncated = true;
        await reader.cancel();
        break;
      }
    }
  } finally {
    text += decoder.decode();
    reader.releaseLock();
  }

  return { text, bytesRead, truncated };
}

export class GitHubApiClient {
  private readonly fetchImpl: FetchLike;
  private tokenRefreshUsed = false;

  constructor(
    private token: string,
    fetchImpl?: FetchLike,
    private readonly timeoutMs = 8_000,
    private readonly refreshToken?: TokenRefresher
  ) {
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init));
  }

  private headers(): Record<string, string> {
    return {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${this.token}`,
      "User-Agent": "IncidentPilot",
      "X-GitHub-Api-Version": "2026-03-10"
    };
  }

  private async authorizedGet(url: string, redirect: RequestRedirect, signal: AbortSignal): Promise<Response> {
    let response = await this.fetchImpl(url, {
      method: "GET",
      headers: this.headers(),
      redirect,
      signal
    });

    if (response.status === 401 && this.refreshToken && !this.tokenRefreshUsed) {
      this.tokenRefreshUsed = true;
      this.token = await this.refreshToken();
      response = await this.fetchImpl(url, {
        method: "GET",
        headers: this.headers(),
        redirect,
        signal
      });
      if (response.status === 401) {
        throw new GitHubApiError(
          "AUTHENTICATION_FAILED_AFTER_REFRESH",
          401,
          response.headers.get("X-GitHub-Request-Id") ?? undefined
        );
      }
    }

    return response;
  }

  private throwForResponse(response: Response, prefix = "HTTP"): never {
    if (rateLimited(response)) {
      throw new GitHubApiError(
        "RATE_LIMITED",
        response.status,
        response.headers.get("X-GitHub-Request-Id") ?? undefined,
        retryDelayFromHeaders(response.headers)
      );
    }
    throw new GitHubApiError(
      `${prefix}_${response.status}`,
      response.status,
      response.headers.get("X-GitHub-Request-Id") ?? undefined
    );
  }

  async getJson<T>(path: string, maxBytes = 1_500_000): Promise<T> {
    return await withRequestDeadline(this.timeoutMs, async (signal) => {
      // Workers supports manual/follow, but rejects redirect: "error".
      // Use manual and reject redirects explicitly without forwarding tokens.
      const response = await this.authorizedGet(`https://api.github.com${path}`, "manual", signal);
      this.rejectUnexpectedRedirect(response);
      if (!response.ok) this.throwForResponse(response);

      const limited = await readTextLimited(response, maxBytes);
      if (limited.truncated) throw new GitHubApiError("RESPONSE_TOO_LARGE", 413);

      try {
        return JSON.parse(limited.text) as T;
      } catch {
        throw new GitHubApiError("MALFORMED_JSON", 502);
      }
    });
  }

  async getJobLog(jobPath: string, maxBytes: number): Promise<LimitedTextResult> {
    const location = await withRequestDeadline(this.timeoutMs, async (signal) => {
      const redirectResponse = await this.authorizedGet(
        `https://api.github.com${jobPath}`,
        "manual",
        signal
      );

      if (redirectResponse.status !== 302) this.throwForResponse(redirectResponse, "LOG_REDIRECT");
      const value = redirectResponse.headers.get("Location");
      if (!value || !isSafeGitHubDownloadRedirect(value)) {
        throw new GitHubSecurityValidationError(
          "UNSAFE_LOG_REDIRECT",
          "GitHub log redirect failed IncidentPilot destination policy"
        );
      }
      return value;
    });

    return await withRequestDeadline(this.timeoutMs, async (signal) => {
      const logResponse = await this.fetchImpl(location, {
        method: "GET",
        headers: { "User-Agent": "IncidentPilot" },
        redirect: "manual",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal
      });

      this.rejectUnexpectedRedirect(logResponse);
      if (!logResponse.ok) this.throwForResponse(logResponse, "LOG_DOWNLOAD");
      return await readTextLimited(logResponse, maxBytes);
    });
  }

  private rejectUnexpectedRedirect(response: Response): void {
    if (response.status >= 300 && response.status < 400) {
      throw new GitHubSecurityValidationError(
        "UNEXPECTED_REDIRECT",
        "GitHub response redirect was blocked by destination policy"
      );
    }
  }
}

export const __testOnly = { retryDelayFromHeaders, rateLimited, withRequestDeadline };
