import type { AppConfig } from "../config.js";
import { LlmError } from "../errors.js";
import type { FetchFunction } from "../http.js";
import type { LlmCompletion, LlmMessage, LlmProvider, LlmUsage } from "./provider.js";

interface ChatCompletionResponse {
  model?: string;
  choices?: Array<{ message?: { content?: string } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export interface ChatCompletionRequest {
  model: string;
  messages: LlmMessage[];
  temperature?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
}

interface RemoteErrorDetails {
  errorType?: string;
  errorCode?: string;
  errorParam?: string;
  remoteMessage?: string;
}

interface ProviderDependencies {
  fetchFn?: FetchFunction;
  now?: () => number;
}

const MAX_REMOTE_ERROR_BYTES = 8_192;
const MAX_REMOTE_MESSAGE_CHARS = 500;
const BEARER_VALUE = /\bBearer\s+[^\s,;"']+/gi;
const LABELED_SECRET = /\b(api[_-]?key|authorization|password|secret|token)(\s*[:=]\s*)[^\s,;"']+/gi;

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function isTimeoutError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "name" in error && error.name === "TimeoutError");
}

function safeTokenCount(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

function parseUsage(value: ChatCompletionResponse["usage"]): LlmUsage | undefined {
  if (!value) return undefined;
  const usage: LlmUsage = {
    promptTokens: safeTokenCount(value.prompt_tokens),
    completionTokens: safeTokenCount(value.completion_tokens),
    totalTokens: safeTokenCount(value.total_tokens)
  };
  return Object.values(usage).some((entry) => entry !== undefined) ? usage : undefined;
}

export function isGpt5Family(model: string): boolean {
  const normalized = model.trim().toLocaleLowerCase("en-US");
  const unqualified = normalized.includes("/") ? normalized.slice(normalized.lastIndexOf("/") + 1) : normalized;
  return /^gpt-5(?:$|[-.])/.test(unqualified);
}

export function buildChatCompletionRequest(config: AppConfig, messages: LlmMessage[]): ChatCompletionRequest {
  const request: ChatCompletionRequest = {
    model: config.llmModel,
    messages
  };

  if (isGpt5Family(config.llmModel)) {
    request.max_completion_tokens = config.llmMaxOutputTokens;
  } else {
    request.temperature = config.llmTemperature;
    request.max_tokens = config.llmMaxOutputTokens;
  }

  return request;
}

function diagnosticBaseUrl(baseUrl: string): string {
  try {
    const parsed = new URL(baseUrl);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return "[invalid-base-url]";
  }
}

function sanitizeRemoteText(value: string, apiKey?: string): string {
  let sanitized = value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(BEARER_VALUE, "Bearer [REDACTED]")
    .replace(LABELED_SECRET, (_match, label: string, separator: string) => `${label}${separator}[REDACTED]`);

  if (apiKey) sanitized = sanitized.split(apiKey).join("[REDACTED]");
  return sanitized.replace(/\s+/g, " ").trim().slice(0, MAX_REMOTE_MESSAGE_CHARS);
}

function sanitizeRemoteField(value: unknown, apiKey?: string): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const sanitized = sanitizeRemoteText(String(value), apiKey);
  return sanitized || undefined;
}

async function readBoundedResponseText(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";

  try {
    while (bytesRead < MAX_REMOTE_ERROR_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = MAX_REMOTE_ERROR_BYTES - bytesRead;
      const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      bytesRead += chunk.byteLength;
      text += decoder.decode(chunk, { stream: bytesRead < MAX_REMOTE_ERROR_BYTES });
      if (value.byteLength > remaining) break;
    }
    text += decoder.decode();
  } catch {
    // Diagnostic body parsing must never hide the original HTTP status.
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Response cleanup is best effort only.
    }
  }

  return text;
}

async function readRemoteErrorDetails(response: Response, apiKey?: string): Promise<RemoteErrorDetails> {
  const raw = await readBoundedResponseText(response);
  if (!raw.trim()) return {};

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const root = parsed as Record<string, unknown>;
      const nested = root.error && typeof root.error === "object" && !Array.isArray(root.error)
        ? root.error as Record<string, unknown>
        : root;
      const details: RemoteErrorDetails = {
        errorType: sanitizeRemoteField(nested.type, apiKey),
        errorCode: sanitizeRemoteField(nested.code, apiKey),
        errorParam: sanitizeRemoteField(nested.param, apiKey),
        remoteMessage: sanitizeRemoteField(nested.message, apiKey)
      };
      if (Object.values(details).some((value) => value !== undefined)) return details;
    }
  } catch {
    // Non-JSON responses are represented by a bounded text message below.
  }

  return { remoteMessage: sanitizeRemoteText(raw, apiKey) || undefined };
}

export class OpenAiCompatibleProvider implements LlmProvider {
  constructor(
    private readonly config: AppConfig,
    private readonly dependencies: ProviderDependencies = {}
  ) {}

  async complete(messages: LlmMessage[]): Promise<LlmCompletion> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.config.llmApiKey) headers.authorization = `Bearer ${this.config.llmApiKey}`;
    const fetchFn = this.dependencies.fetchFn ?? fetch;
    const now = this.dependencies.now ?? Date.now;
    const startedAt = now();
    const safeBaseUrl = diagnosticBaseUrl(this.config.llmBaseUrl);

    let response: Response;
    try {
      response = await fetchFn(`${this.config.llmBaseUrl}/v1/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(buildChatCompletionRequest(this.config, messages)),
        signal: AbortSignal.timeout(this.config.llmTimeoutMs)
      });
    } catch (cause) {
      const timedOut = isTimeoutError(cause);
      throw new LlmError(
        timedOut
          ? `LLM request timed out after ${this.config.llmTimeoutMs}ms.`
          : "LLM request failed before a response was received.",
        {
          cause,
          context: {
            baseUrl: safeBaseUrl,
            model: this.config.llmModel,
            timeoutMs: this.config.llmTimeoutMs,
            latencyMs: Math.max(0, Math.round(now() - startedAt)),
            retryable: true,
            kind: timedOut ? "timeout" : "network"
          }
        }
      );
    }

    if (!response.ok) {
      const retryable = isRetryableStatus(response.status);
      const remote = await readRemoteErrorDetails(response, this.config.llmApiKey);
      const latencyMs = Math.max(0, Math.round(now() - startedAt));
      const statusLabel = `${response.status} ${response.statusText || "error"}`;
      const remoteSuffix = remote.remoteMessage ? `: ${remote.remoteMessage}` : "";
      throw new LlmError(`LLM request failed with HTTP ${statusLabel}${remoteSuffix}.`, {
        context: {
          baseUrl: safeBaseUrl,
          model: this.config.llmModel,
          status: response.status,
          latencyMs,
          retryable,
          kind: "http",
          ...remote
        }
      });
    }

    let body: ChatCompletionResponse;
    try {
      body = (await response.json()) as ChatCompletionResponse;
    } catch (cause) {
      throw new LlmError("LLM response was not valid JSON.", {
        cause,
        context: {
          baseUrl: safeBaseUrl,
          model: this.config.llmModel,
          latencyMs: Math.max(0, Math.round(now() - startedAt)),
          retryable: true,
          kind: "invalid-response-json"
        }
      });
    }

    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw new LlmError("LLM response contained no message content.", {
        context: {
          baseUrl: safeBaseUrl,
          model: this.config.llmModel,
          latencyMs: Math.max(0, Math.round(now() - startedAt)),
          retryable: true,
          kind: "empty-response"
        }
      });
    }

    return {
      content,
      model: body.model,
      latencyMs: Math.max(0, Math.round(now() - startedAt)),
      usage: parseUsage(body.usage)
    };
  }
}
