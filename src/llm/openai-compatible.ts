import type { AppConfig } from "../config.js";
import { LlmError } from "../errors.js";
import type { LlmMessage, LlmProvider } from "./provider.js";

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

export class OpenAiCompatibleProvider implements LlmProvider {
  constructor(private readonly config: AppConfig) {}

  async complete(messages: LlmMessage[]): Promise<string> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.config.llmApiKey) headers.authorization = `Bearer ${this.config.llmApiKey}`;

    let response: Response;
    try {
      response = await fetch(`${this.config.llmBaseUrl}/v1/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: this.config.llmModel,
          messages,
          temperature: 0.2
        }),
        signal: AbortSignal.timeout(120_000)
      });
    } catch (cause) {
      throw new LlmError("LLM request failed before a response was received.", {
        cause,
        context: { baseUrl: this.config.llmBaseUrl, model: this.config.llmModel }
      });
    }

    if (!response.ok) {
      throw new LlmError(`LLM request failed with HTTP ${response.status} ${response.statusText}.`, {
        context: {
          baseUrl: this.config.llmBaseUrl,
          model: this.config.llmModel,
          status: response.status
        }
      });
    }

    let body: ChatCompletionResponse;
    try {
      body = (await response.json()) as ChatCompletionResponse;
    } catch (cause) {
      throw new LlmError("LLM response was not valid JSON.", {
        cause,
        context: { baseUrl: this.config.llmBaseUrl, model: this.config.llmModel }
      });
    }

    const content = body.choices?.[0]?.message?.content;
    if (!content) {
      throw new LlmError("LLM response contained no message content.", {
        context: { baseUrl: this.config.llmBaseUrl, model: this.config.llmModel }
      });
    }
    return content;
  }
}
