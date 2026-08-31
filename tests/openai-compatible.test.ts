import assert from "node:assert/strict";
import test from "node:test";
import { parseConfig } from "../src/config.js";
import { LlmError } from "../src/errors.js";
import { isGpt5Family, OpenAiCompatibleProvider } from "../src/llm/openai-compatible.js";

const structuredMessages = [
  { role: "system" as const, content: "Return only JSON when requested." },
  { role: "user" as const, content: "Return {\"ok\":true}." }
];

async function captureRequest(model: string): Promise<Record<string, unknown>> {
  const config = parseConfig({
    LLM_MODEL: model,
    LLM_TEMPERATURE: "0.4",
    LLM_MAX_OUTPUT_TOKENS: "2048"
  });
  let requestBody: Record<string, unknown> = {};
  const provider = new OpenAiCompatibleProvider(config, {
    fetchFn: async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        model,
        choices: [{ message: { content: "{\"ok\":true}" } }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });
  await provider.complete(structuredMessages);
  return requestBody;
}

test("gpt-4.1-mini keeps conventional Chat Completions parameters and structured JSON messages", async () => {
  const requestBody = await captureRequest("gpt-4.1-mini");
  assert.equal(requestBody.model, "gpt-4.1-mini");
  assert.equal(requestBody.temperature, 0.4);
  assert.equal(requestBody.max_tokens, 2048);
  assert.equal("max_completion_tokens" in requestBody, false);
  assert.equal("top_p" in requestBody, false);
  assert.deepEqual(requestBody.messages, structuredMessages);
});

test("gpt-5-mini omits legacy sampling parameters and uses max_completion_tokens", async () => {
  const requestBody = await captureRequest("gpt-5-mini");
  assert.equal(requestBody.model, "gpt-5-mini");
  assert.equal("temperature" in requestBody, false);
  assert.equal("top_p" in requestBody, false);
  assert.equal("max_tokens" in requestBody, false);
  assert.equal(requestBody.max_completion_tokens, 2048);
  assert.deepEqual(requestBody.messages, structuredMessages);
});

test("GPT-5 family detection covers nano and snapshot/provider-qualified model names", async () => {
  assert.equal(isGpt5Family("gpt-5"), true);
  assert.equal(isGpt5Family("gpt-5-nano"), true);
  assert.equal(isGpt5Family("gpt-5-mini-2025-08-07"), true);
  assert.equal(isGpt5Family("openai/gpt-5-nano-2025-08-07"), true);
  assert.equal(isGpt5Family("gpt-5.1"), true);
  assert.equal(isGpt5Family("gpt-4.1-mini"), false);
  assert.equal(isGpt5Family("gpt-50"), false);

  const requestBody = await captureRequest("gpt-5-nano-2025-08-07");
  assert.equal("temperature" in requestBody, false);
  assert.equal(requestBody.max_completion_tokens, 2048);
});

test("OpenAI-compatible provider supports local endpoints without an API key and returns usage", async () => {
  const config = parseConfig({ LLM_MODEL: "local-model" });
  let requestHeaders = new Headers();
  let clock = 1_000;
  const provider = new OpenAiCompatibleProvider(config, {
    now: () => { clock += 25; return clock; },
    fetchFn: async (_input, init) => {
      requestHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({
        model: "local-model-resolved",
        choices: [{ message: { content: "{\"ok\":true}" } }],
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });

  const result = await provider.complete([{ role: "user", content: "hello" }]);
  assert.equal(requestHeaders.get("authorization"), null);
  assert.equal(result.model, "local-model-resolved");
  assert.deepEqual(result.usage, { promptTokens: 11, completionTokens: 7, totalTokens: 18 });
  assert.equal(result.latencyMs, 25);
});

test("provider exposes sanitized OpenAI 400 diagnostics and keeps request errors non-retryable", async () => {
  const apiKey = "cloud-super-secret";
  const config = parseConfig({
    LLM_BASE_URL: "https://api.openai.com",
    LLM_MODEL: "gpt-5-mini",
    LLM_API_KEY: apiKey
  });
  let clock = 1_000;
  const provider = new OpenAiCompatibleProvider(config, {
    now: () => { clock += 25; return clock; },
    fetchFn: async (_input, init) => {
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${apiKey}`);
      return new Response(JSON.stringify({
        error: {
          message: "Unsupported parameter: temperature",
          type: "invalid_request_error",
          param: "temperature",
          code: "unsupported_parameter"
        }
      }), { status: 400, statusText: "Bad Request", headers: { "content-type": "application/json" } });
    }
  });

  await assert.rejects(
    provider.complete(structuredMessages),
    (error: unknown) => {
      assert.ok(error instanceof LlmError);
      assert.equal(error.context?.status, 400);
      assert.equal(error.context?.model, "gpt-5-mini");
      assert.equal(error.context?.baseUrl, "https://api.openai.com");
      assert.equal(error.context?.errorType, "invalid_request_error");
      assert.equal(error.context?.errorCode, "unsupported_parameter");
      assert.equal(error.context?.errorParam, "temperature");
      assert.equal(error.context?.remoteMessage, "Unsupported parameter: temperature");
      assert.equal(error.context?.retryable, false);
      assert.equal(error.context?.latencyMs, 25);
      assert.match(error.message, /Unsupported parameter: temperature/);
      const serialized = JSON.stringify({ message: error.message, context: error.context });
      assert.doesNotMatch(serialized, /cloud-super-secret/);
      assert.doesNotMatch(serialized, /authorization/i);
      return true;
    }
  );
});

test("provider marks transient HTTP failures retryable and bounds non-JSON diagnostics", async () => {
  const config = parseConfig({ LLM_MODEL: "cloud-model", LLM_API_KEY: "cloud-super-secret" });
  const provider = new OpenAiCompatibleProvider(config, {
    fetchFn: async () => new Response(`unavailable ${"x".repeat(10_000)}`, { status: 503, statusText: "Unavailable" })
  });

  await assert.rejects(
    provider.complete([{ role: "user", content: "hello" }]),
    (error: unknown) => {
      assert.ok(error instanceof LlmError);
      assert.equal(error.context?.retryable, true);
      assert.equal(error.context?.status, 503);
      assert.equal(typeof error.context?.remoteMessage, "string");
      assert.ok(String(error.context?.remoteMessage).length <= 500);
      assert.doesNotMatch(JSON.stringify({ message: error.message, context: error.context }), /cloud-super-secret/);
      return true;
    }
  );
});

test("provider classifies an aborted timeout as retryable", async () => {
  const config = { ...parseConfig({ LLM_MODEL: "slow-model" }), llmTimeoutMs: 5 };
  const provider = new OpenAiCompatibleProvider(config, {
    fetchFn: async (_input, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return reject(new Error("missing signal"));
      const keepAlive = setTimeout(() => reject(new Error("timeout signal did not fire")), 100);
      if (signal.aborted) {
        clearTimeout(keepAlive);
        return reject(signal.reason);
      }
      signal.addEventListener("abort", () => {
        clearTimeout(keepAlive);
        reject(signal.reason);
      }, { once: true });
    })
  });

  await assert.rejects(
    provider.complete([{ role: "user", content: "hello" }]),
    (error: unknown) => error instanceof LlmError && error.context?.kind === "timeout" && error.context?.retryable === true
  );
});
