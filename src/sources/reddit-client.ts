import { FetchError } from "../errors.js";
import { retryDelayMs, sleep as defaultSleep, type FetchFunction, type SleepFunction } from "../http.js";

export interface RedditClientConfig {
  clientId: string;
  clientSecret: string;
  userAgent: string;
  timeoutMs: number;
  retries: number;
  retryBaseDelayMs: number;
  maxResponseBytes: number;
  maxRateLimitWaitMs: number;
}

export interface RedditClientDependencies {
  fetchFn?: FetchFunction;
  sleep?: SleepFunction;
  now?: () => number;
}

interface CachedToken {
  value: string;
  expiresAtMs: number;
}

function boundedDelay(value: number, max: number): number {
  return Math.max(0, Math.min(Math.round(value), max));
}

function responseDelayMs(response: Response): number | undefined {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter && /^\d+(?:\.\d+)?$/.test(retryAfter.trim())) {
    return Number(retryAfter) * 1_000;
  }
  const reset = response.headers.get("x-ratelimit-reset");
  if (reset && /^\d+(?:\.\d+)?$/.test(reset.trim())) {
    return Number(reset) * 1_000;
  }
  return undefined;
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const length = response.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > maxBytes) {
    try { await response.body?.cancel(); } catch { /* best effort */ }
    throw new FetchError(`Reddit response exceeded ${maxBytes} bytes.`, {
      context: { status: response.status, maxBytes }
    });
  }

  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new FetchError(`Reddit response exceeded ${maxBytes} bytes.`, {
          context: { status: response.status, maxBytes }
        });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}

function parseJson<T>(text: string, context: Record<string, unknown>): T {
  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    throw new FetchError("Reddit API returned invalid JSON.", { cause, context });
  }
}

export class RedditClient {
  private readonly fetchFn: FetchFunction;
  private readonly sleep: SleepFunction;
  private readonly now: () => number;
  private token?: CachedToken;
  private rateRemaining?: number;
  private rateResetAtMs?: number;

  constructor(private readonly config: RedditClientConfig, dependencies: RedditClientDependencies = {}) {
    this.fetchFn = dependencies.fetchFn ?? fetch;
    this.sleep = dependencies.sleep ?? defaultSleep;
    this.now = dependencies.now ?? (() => Date.now());
  }

  private updateRateLimit(response: Response): void {
    const remaining = Number(response.headers.get("x-ratelimit-remaining"));
    const resetSeconds = Number(response.headers.get("x-ratelimit-reset"));
    if (Number.isFinite(remaining)) this.rateRemaining = remaining;
    if (Number.isFinite(resetSeconds) && resetSeconds >= 0) {
      this.rateResetAtMs = this.now() + resetSeconds * 1_000;
    }
  }

  private async respectRateLimit(): Promise<void> {
    if (this.rateRemaining === undefined || this.rateRemaining > 1 || !this.rateResetAtMs) return;
    const waitMs = Math.max(0, this.rateResetAtMs - this.now());
    if (waitMs <= 0) return;
    if (waitMs > this.config.maxRateLimitWaitMs) {
      throw new FetchError("Reddit API quota is exhausted for longer than the configured wait window.", {
        context: { kind: "rate-limit", waitMs, maxRateLimitWaitMs: this.config.maxRateLimitWaitMs }
      });
    }
    await this.sleep(waitMs);
  }

  private async requestJson<T>(
    url: string,
    request: RequestInit,
    options: { rateLimited: boolean; kind: string }
  ): Promise<T> {
    const totalAttempts = this.config.retries + 1;
    for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
      if (options.rateLimited) await this.respectRateLimit();
      const headers = new Headers(request.headers);
      headers.set("user-agent", this.config.userAgent);
      headers.set("accept", "application/json");
      const timeoutSignal = AbortSignal.timeout(this.config.timeoutMs);
      let response: Response;
      try {
        response = await this.fetchFn(url, { ...request, headers, signal: timeoutSignal });
      } catch (cause) {
        if (attempt === totalAttempts) {
          throw new FetchError(`Reddit ${options.kind} request failed after ${attempt} attempt${attempt === 1 ? "" : "s"}.`, {
            cause,
            context: { kind: options.kind, attempt, attempts: totalAttempts }
          });
        }
        await this.sleep(retryDelayMs(this.config.retryBaseDelayMs, attempt));
        continue;
      }

      if (options.rateLimited) this.updateRateLimit(response);
      const body = await readBoundedText(response, this.config.maxResponseBytes);
      if (response.ok) return parseJson<T>(body, { kind: options.kind, status: response.status });

      const retryable = response.status === 408 || response.status === 425 || response.status === 429 ||
        response.status === 500 || response.status === 502 || response.status === 503 || response.status === 504;
      if (!retryable || attempt === totalAttempts) {
        const kind = response.status === 401 ? "authentication"
          : response.status === 403 ? "forbidden"
          : response.status === 404 ? "not-found"
          : response.status === 429 ? "rate-limit"
          : options.kind;
        throw new FetchError(`Reddit ${options.kind} request failed with HTTP ${response.status}.`, {
          context: { kind, status: response.status, retryable, attempt, attempts: totalAttempts }
        });
      }

      const headerDelay = responseDelayMs(response) ?? 0;
      const delayMs = Math.max(retryDelayMs(this.config.retryBaseDelayMs, attempt), headerDelay);
      if (delayMs > this.config.maxRateLimitWaitMs) {
        throw new FetchError("Reddit requested a retry delay longer than the configured wait window.", {
          context: { kind: "rate-limit", status: response.status, delayMs, maxRateLimitWaitMs: this.config.maxRateLimitWaitMs }
        });
      }
      await this.sleep(boundedDelay(delayMs, this.config.maxRateLimitWaitMs));
    }

    throw new FetchError(`Reddit ${options.kind} request failed.`, { context: { kind: options.kind } });
  }

  async getAccessToken(): Promise<string> {
    if (this.token && this.token.expiresAtMs > this.now() + 60_000) return this.token.value;
    const basic = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`, "utf8").toString("base64");
    const payload = await this.requestJson<{
      access_token?: unknown;
      token_type?: unknown;
      expires_in?: unknown;
    }>("https://www.reddit.com/api/v1/access_token", {
      method: "POST",
      headers: {
        authorization: `Basic ${basic}`,
        "content-type": "application/x-www-form-urlencoded"
      },
      body: "grant_type=client_credentials"
    }, { rateLimited: false, kind: "oauth-token" });

    if (typeof payload.access_token !== "string" || !payload.access_token ||
        typeof payload.expires_in !== "number" || payload.expires_in <= 0) {
      throw new FetchError("Reddit OAuth token response was missing required fields.", {
        context: { kind: "authentication" }
      });
    }
    this.token = {
      value: payload.access_token,
      expiresAtMs: this.now() + payload.expires_in * 1_000
    };
    return this.token.value;
  }

  async getJson<T>(path: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
    const token = await this.getAccessToken();
    const url = new URL(path, "https://oauth.reddit.com");
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return this.requestJson<T>(url.toString(), {
      method: "GET",
      headers: { authorization: `Bearer ${token}` }
    }, { rateLimited: true, kind: "api" });
  }
}
