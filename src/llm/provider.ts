import { LlmError } from "../errors.js";

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface LlmCompletion {
  content: string;
  model?: string;
  latencyMs: number;
  usage?: LlmUsage;
}

export interface LlmProvider {
  complete(messages: LlmMessage[]): Promise<LlmCompletion>;
}

export function isRetryableLlmError(error: unknown): boolean {
  return error instanceof LlmError && error.context?.retryable === true;
}

export function parseJsonObject<T>(raw: string): T {
  const trimmed = raw.trim();
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  try {
    const parsed = JSON.parse(unfenced) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new LlmError("LLM response was not a JSON object.", {
        context: { retryable: true, kind: "invalid-output" }
      });
    }
    return parsed as T;
  } catch (cause) {
    if (cause instanceof LlmError) throw cause;
    throw new LlmError("LLM response was not valid JSON.", {
      cause,
      context: { retryable: true, kind: "invalid-output" }
    });
  }
}
