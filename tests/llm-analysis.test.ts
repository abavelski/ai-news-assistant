import assert from "node:assert/strict";
import test from "node:test";
import { LlmError } from "../src/errors.js";
import {
  analyzeArticle,
  ARTICLE_ANALYSIS_VERSION,
  articleAnalysisIdentity,
  parseArticleAnalysis
} from "../src/llm/article-analysis.js";
import { boundedArticleText, ARTICLE_ANALYSIS_PROMPT_VERSION } from "../src/llm/prompts.js";
import type { LlmCompletion, LlmMessage, LlmProvider } from "../src/llm/provider.js";
import type { Article } from "../src/types.js";

const validPayload = {
  summary: "Validated summary",
  topics: ["world", "policy"],
  importance: 73,
  recommended: true,
  reason: "Material development",
  keyFacts: ["Fact one", "Fact two"]
};

function article(): Article & { id: number } {
  return {
    id: 42,
    sourceId: "meduza",
    externalId: "story-42",
    url: "https://meduza.io/feature/story-42",
    title: "Story 42",
    publishedAt: "2026-08-29T08:00:00.000Z",
    language: "ru",
    text: "Beginning " + "body ".repeat(1000) + " ending 👩‍💻",
    contentHtml: "<p>body</p>",
    contentHash: "hash",
    fetchedAt: "2026-08-29T08:01:00.000Z"
  };
}

class SequenceProvider implements LlmProvider {
  calls = 0;
  messages: LlmMessage[][] = [];

  constructor(private readonly outcomes: Array<LlmCompletion | Error>) {}

  async complete(messages: LlmMessage[]): Promise<LlmCompletion> {
    this.messages.push(messages);
    const outcome = this.outcomes[this.calls];
    this.calls += 1;
    if (outcome instanceof Error) throw outcome;
    if (!outcome) throw new Error("missing fake outcome");
    return outcome;
  }
}

function completion(content: string, latencyMs = 12): LlmCompletion {
  return {
    content,
    latencyMs,
    model: "reported-model",
    usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 }
  };
}

const baseOptions = {
  language: "ru",
  modelName: "configured-model",
  maxArticleChars: 1_000,
  retries: 2,
  retryBaseDelayMs: 25
};

test("article analysis accepts valid JSON and records cache identity plus usage", async () => {
  const provider = new SequenceProvider([completion(JSON.stringify(validPayload))]);
  const result = await analyzeArticle(article(), provider, { ...baseOptions, sleep: async () => undefined });

  assert.equal(result.summary, validPayload.summary);
  assert.equal(result.importance, 73);
  assert.equal(result.modelName, "configured-model");
  assert.equal(result.promptVersion, ARTICLE_ANALYSIS_PROMPT_VERSION);
  assert.equal(result.analysisVersion, ARTICLE_ANALYSIS_VERSION);
  assert.equal(result.latencyMs, 12);
  assert.equal(result.promptTokens, 100);
  assert.equal(result.completionTokens, 20);
  assert.equal(result.totalTokens, 120);
  assert.equal(provider.calls, 1);
});

test("article analysis accepts fenced JSON", () => {
  const parsed = parseArticleAnalysis(`\`\`\`json\n${JSON.stringify(validPayload)}\n\`\`\``);
  assert.deepEqual(parsed, validPayload);
});

test("malformed or schema-invalid JSON is retried and never accepted as valid analysis", async () => {
  const delays: number[] = [];
  const provider = new SequenceProvider([
    completion("{not-json"),
    completion(JSON.stringify({ ...validPayload, importance: "high" })),
    completion(JSON.stringify(validPayload))
  ]);

  const result = await analyzeArticle(article(), provider, {
    ...baseOptions,
    sleep: async (milliseconds) => { delays.push(milliseconds); }
  });

  assert.equal(result.summary, validPayload.summary);
  assert.equal(provider.calls, 3);
  assert.deepEqual(delays, [25, 50]);
  assert.equal(result.latencyMs, 36);
  assert.equal(result.totalTokens, 360);
});

test("exhausted invalid outputs fail instead of producing an analysis", async () => {
  const provider = new SequenceProvider([
    completion("not-json"),
    completion(JSON.stringify({ ...validPayload, topics: "not-an-array" }))
  ]);

  await assert.rejects(
    analyzeArticle(article(), provider, {
      ...baseOptions,
      retries: 1,
      sleep: async () => undefined
    }),
    (error: unknown) => error instanceof LlmError && /schema validation|valid JSON/.test(error.message)
  );
  assert.equal(provider.calls, 2);
});

test("transient provider failures and timeout errors are retried", async () => {
  const timeout = new LlmError("timed out", { context: { retryable: true, kind: "timeout" } });
  const transient = new LlmError("service unavailable", { context: { retryable: true, kind: "http", status: 503 } });
  const provider = new SequenceProvider([timeout, transient, completion(JSON.stringify(validPayload))]);

  const result = await analyzeArticle(article(), provider, { ...baseOptions, sleep: async () => undefined });
  assert.equal(result.summary, validPayload.summary);
  assert.equal(provider.calls, 3);
});

test("non-retryable provider failures stop immediately", async () => {
  const provider = new SequenceProvider([
    new LlmError("bad request", { context: { retryable: false, status: 400 } }),
    completion(JSON.stringify(validPayload))
  ]);

  await assert.rejects(
    analyzeArticle(article(), provider, { ...baseOptions, sleep: async () => undefined }),
    /bad request/
  );
  assert.equal(provider.calls, 1);
});

test("bounded article text preserves beginning, end, and complete Unicode graphemes", () => {
  const text = "BEGIN-" + "a".repeat(80) + "👩‍💻" + "b".repeat(80) + "-END👨‍👩‍👧‍👦";
  const bounded = boundedArticleText(text, 90);
  const units = Array.from(new Intl.Segmenter("und", { granularity: "grapheme" }).segment(bounded), (entry) => entry.segment);

  assert.ok(units.length <= 90);
  assert.match(bounded, /^BEGIN-/);
  assert.match(bounded, /-END👨‍👩‍👧‍👦$/);
  assert.match(bounded, /middle omitted/);
  assert.doesNotMatch(bounded, /\uFFFD/);
});

test("analysis identity changes when model changes while prompt/schema versions remain explicit", () => {
  assert.deepEqual(articleAnalysisIdentity("model-a"), {
    modelName: "model-a",
    promptVersion: ARTICLE_ANALYSIS_PROMPT_VERSION,
    analysisVersion: ARTICLE_ANALYSIS_VERSION
  });
  assert.notDeepEqual(articleAnalysisIdentity("model-a"), articleAnalysisIdentity("model-b"));
});
