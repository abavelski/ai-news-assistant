import { LlmError } from "../errors.js";

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmProvider {
  complete(messages: LlmMessage[]): Promise<string>;
}

export function parseJsonObject<T>(raw: string): T {
  const trimmed = raw.trim();
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  try {
    return JSON.parse(unfenced) as T;
  } catch (cause) {
    throw new LlmError("LLM response was not valid JSON.", { cause });
  }
}
