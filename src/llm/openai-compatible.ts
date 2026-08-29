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

interface ProviderDependencies {
  fetchFn?: FetchFunction;
  now?: () => number;
}

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

    let response: Response;
    try {
      response = await fetchFn(`${this.config.llmBaseUrl}/v1/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: this.config.llmModel,
          messages,
          temperature: this.config.llmTemperature,
          max_tokens: this.config.llmMaxOutputTokens
        }),
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
            baseUrl: this.config.llmBaseUrl,
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
      try {
        await response.body?.cancel();
      } catch {
        // Response cleanup is best effort only.
      }
      throw new LlmError(`LLM request failed with HTTP ${response.status} ${response.statusText || "error"}.`, {
        context: {
          baseUrl: this.config.llmBaseUrl,
          model: this.config.llmModel,
          status: response.status,
          latencyMs: Math.max(0, Math.round(now() - startedAt)),
          retryable,
          kind: "http"
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
          baseUrl: this.config.llmBaseUrl,
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
          baseUrl: this.config.llmBaseUrl,
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
