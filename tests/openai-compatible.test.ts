import assert from "node:assert/strict";
import test from "node:test";
import { parseConfig } from "../src/config.js";
import { LlmError } from "../src/errors.js";
import { OpenAiCompatibleProvider } from "../src/llm/openai-compatible.js";

test("OpenAI-compatible provider supports local endpoints without an API key and sends configured parameters", async () => {
  const config = parseConfig({
    LLM_MODEL: "local-model",
    LLM_TEMPERATURE: "0.4",
    LLM_MAX_OUTPUT_TOKENS: "2048"
  });
  let requestHeaders = new Headers();
  let requestBody: Record<string, unknown> = {};
  let clock = 1_000;
  const provider = new OpenAiCompatibleProvider(config, {
    now: () => { clock += 25; return clock; },
    fetchFn: async (_input, init) => {
      requestHeaders = new Headers(init?.headers);
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        model: "local-model-resolved",
        choices: [{ message: { content: "{\"ok\":true}" } }],
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });

  const result = await provider.complete([{ role: "user", content: "hello" }]);
  assert.equal(requestHeaders.get("authorization"), null);
  assert.equal(requestBody.model, "local-model");
  assert.equal(requestBody.temperature, 0.4);
  assert.equal(requestBody.max_tokens, 2048);
  assert.equal(result.model, "local-model-resolved");
  assert.deepEqual(result.usage, { promptTokens: 11, completionTokens: 7, totalTokens: 18 });
  assert.equal(result.latencyMs, 25);
});

test("provider marks transient HTTP failures retryable without exposing cloud API keys", async () => {
  const config = parseConfig({ LLM_MODEL: "cloud-model", LLM_API_KEY: "cloud-super-secret" });
  const provider = new OpenAiCompatibleProvider(config, {
    fetchFn: async (_input, init) => {
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer cloud-super-secret");
      return new Response("unavailable", { status: 503, statusText: "Unavailable" });
    }
  });

  await assert.rejects(
    provider.complete([{ role: "user", content: "hello" }]),
    (error: unknown) => {
      assert.ok(error instanceof LlmError);
      assert.equal(error.context?.retryable, true);
      assert.doesNotMatch(JSON.stringify(error), /cloud-super-secret/);
      assert.doesNotMatch(error.message, /cloud-super-secret/);
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
