import type { AppConfig } from "../config.js";
import type { LlmMessage, LlmProvider } from "./provider.js";

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

export class OpenAiCompatibleProvider implements LlmProvider {
  constructor(private readonly config: AppConfig) {}

  async complete(messages: LlmMessage[]): Promise<string> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.config.llmApiKey) headers.authorization = `Bearer ${this.config.llmApiKey}`;

    const response = await fetch(`${this.config.llmBaseUrl}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: this.config.llmModel,
        messages,
        temperature: 0.2
      }),
      signal: AbortSignal.timeout(120_000)
    });

    if (!response.ok) {
      throw new Error(`LLM request failed: ${response.status} ${await response.text()}`);
    }

    const body = (await response.json()) as ChatCompletionResponse;
    const content = body.choices?.[0]?.message?.content;
    if (!content) throw new Error("LLM response contained no message content");
    return content;
  }
}
