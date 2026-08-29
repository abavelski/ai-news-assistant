import { FetchError } from "./errors.js";

export type FetchFunction = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type SleepFunction = (milliseconds: number) => Promise<void>;

export interface HttpRetryEvent {
  url: string;
  attempt: number;
  nextAttempt: number;
  delayMs: number;
  status?: number;
  error?: unknown;
}

export interface HttpRequestOptions {
  userAgent: string;
  timeoutMs: number;
  retries: number;
  retryBaseDelayMs: number;
  request?: RequestInit;
  fetchFn?: FetchFunction;
  sleep?: SleepFunction;
  onRetry?: (event: HttpRetryEvent) => void;
}

export const sleep: SleepFunction = async (milliseconds) => {
  if (milliseconds <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
};

export function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

export function retryDelayMs(baseDelayMs: number, failedAttempt: number): number {
  return Math.min(baseDelayMs * 2 ** Math.max(0, failedAttempt - 1), 30_000);
}

async function discardResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Best effort only; a retry should not be blocked by body cleanup.
  }
}

export async function fetchWithRetry(url: string, options: HttpRequestOptions): Promise<Response> {
  const fetchFn = options.fetchFn ?? fetch;
  const sleepFn = options.sleep ?? sleep;
  const totalAttempts = options.retries + 1;

  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    const headers = new Headers(options.request?.headers);
    if (!headers.has("user-agent")) headers.set("user-agent", options.userAgent);
    const timeoutSignal = AbortSignal.timeout(options.timeoutMs);
    const signal = options.request?.signal
      ? AbortSignal.any([options.request.signal, timeoutSignal])
      : timeoutSignal;

    let response: Response;
    try {
      response = await fetchFn(url, {
        ...options.request,
        headers,
        signal
      });
    } catch (cause) {
      if (attempt === totalAttempts) {
        throw new FetchError(`Request failed after ${attempt} attempt${attempt === 1 ? "" : "s"}: ${url}.`, {
          cause,
          context: { url, attempt, attempts: totalAttempts, timeoutMs: options.timeoutMs }
        });
      }

      const delayMs = retryDelayMs(options.retryBaseDelayMs, attempt);
      options.onRetry?.({ url, attempt, nextAttempt: attempt + 1, delayMs, error: cause });
      await sleepFn(delayMs);
      continue;
    }

    if (response.ok) return response;

    const retryable = isRetryableHttpStatus(response.status);
    if (!retryable || attempt === totalAttempts) {
      await discardResponse(response);
      throw new FetchError(`Request failed with HTTP ${response.status} ${response.statusText || "error"}: ${url}.`, {
        context: {
          url,
          status: response.status,
          attempt,
          attempts: totalAttempts,
          retryable
        }
      });
    }

    await discardResponse(response);
    const delayMs = retryDelayMs(options.retryBaseDelayMs, attempt);
    options.onRetry?.({ url, attempt, nextAttempt: attempt + 1, delayMs, status: response.status });
    await sleepFn(delayMs);
  }

  throw new FetchError(`Request failed: ${url}.`, { context: { url } });
}
