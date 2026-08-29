import assert from "node:assert/strict";
import test from "node:test";
import {
  deterministicEditorialPlan,
  parseEditorialPlan,
  selectEditorialPlan
} from "../src/llm/editorial.js";
import { EDITORIAL_PROMPT_VERSION } from "../src/llm/prompts.js";
import type { LlmCompletion, LlmMessage, LlmProvider } from "../src/llm/provider.js";
import type { EditionArticle } from "../src/types.js";

class FakeProvider implements LlmProvider {
  calls = 0;
  messages: LlmMessage[][] = [];

  constructor(private readonly outcome: LlmCompletion | Error) {}

  async complete(messages: LlmMessage[]): Promise<LlmCompletion> {
    this.calls += 1;
    this.messages.push(messages);
    if (this.outcome instanceof Error) throw this.outcome;
    return this.outcome;
  }
}

function completion(content: string): LlmCompletion {
  return { content, latencyMs: 10, model: "reported-editor-model" };
}

function item(options: {
  id: number;
  title: string;
  topic: string;
  summary: string;
  importance: number;
  recommended: boolean;
  publishedAt: string;
}): EditionArticle {
  return {
    article: {
      id: options.id,
      sourceId: "meduza",
      externalId: `story-${options.id}`,
      url: `https://meduza.io/feature/story-${options.id}`,
      title: options.title,
      publishedAt: options.publishedAt,
      language: "ru",
      text: `RAW_FULL_ARTICLE_BODY_${options.id}`,
      contentHtml: `<p>RAW_HTML_BODY_${options.id}</p>`,
      contentHash: `hash-${options.id}`,
      fetchedAt: options.publishedAt
    },
    analysis: {
      articleId: options.id,
      modelName: "analysis-model",
      promptVersion: "article-analysis-v1",
      analysisVersion: "article-analysis-schema-v1",
      summary: options.summary,
      topics: [options.topic],
      importance: options.importance,
      recommended: options.recommended,
      reason: `Причина для материала ${options.id}`,
      keyFacts: [`Факт ${options.id}`],
      analyzedAt: options.publishedAt,
      latencyMs: 10
    }
  };
}

const items: EditionArticle[] = [
  item({
    id: 1,
    title: "Новый бюджет правительства",
    topic: "экономика",
    summary: "Правительство представило новый бюджет и изменило основные параметры расходов.",
    importance: 95,
    recommended: false,
    publishedAt: "2026-08-29T10:00:00.000Z"
  }),
  item({
    id: 2,
    title: "Переговоры лидеров завершились соглашением",
    topic: "политика",
    summary: "Лидеры завершили переговоры и объявили о новом соглашении по ключевым вопросам.",
    importance: 85,
    recommended: true,
    publishedAt: "2026-08-29T09:00:00.000Z"
  }),
  item({
    id: 3,
    title: "Исследователи представили новый процессор",
    topic: "технологии",
    summary: "Исследователи представили процессор с новым подходом к энергоэффективным вычислениям.",
    importance: 95,
    recommended: false,
    publishedAt: "2026-08-28T00:00:00.000Z"
  })
];

const options = {
  language: "ru",
  modelName: "editor-model",
  maxArticles: 3,
  maxPerTopic: 2
};

test("valid editorial output is accepted and prompt contains metadata but never raw article bodies", async () => {
  const provider = new FakeProvider(completion(JSON.stringify({
    overview: "К утру выделяются три содержательных сюжета.",
    selectedArticleIds: [2, 1, 3]
  })));

  const result = await selectEditorialPlan(items, provider, options);
  assert.deepEqual(result.plan.selectedArticleIds, [2, 1, 3]);
  assert.equal(result.metadata.selectionMethod, "llm");
  assert.equal(result.metadata.modelName, "editor-model");
  assert.equal(result.metadata.promptVersion, EDITORIAL_PROMPT_VERSION);
  assert.equal(provider.calls, 1);

  const prompt = provider.messages[0]?.[1]?.content ?? "";
  assert.match(prompt, /language 'ru'/);
  assert.match(prompt, /Новый бюджет правительства/);
  assert.match(prompt, /Факт 1/);
  assert.doesNotMatch(prompt, /RAW_FULL_ARTICLE_BODY|RAW_HTML_BODY/);
});

test("editorial fake provider with unknown ids falls back instead of silently accepting them", async () => {
  const provider = new FakeProvider(completion(JSON.stringify({ overview: "Обзор", selectedArticleIds: [999, 1] })));
  const result = await selectEditorialPlan(items, provider, { ...options, maxArticles: 2 });
  assert.equal(result.metadata.selectionMethod, "fallback");
  assert.equal(new Set(result.plan.selectedArticleIds).size, result.plan.selectedArticleIds.length);
  assert.ok(result.plan.selectedArticleIds.every((id) => items.some((entry) => entry.article.id === id)));
});

test("editorial fake provider with duplicate ids falls back", async () => {
  const provider = new FakeProvider(completion(JSON.stringify({ overview: "Обзор", selectedArticleIds: [1, 1] })));
  const result = await selectEditorialPlan(items, provider, { ...options, maxArticles: 2 });
  assert.equal(result.metadata.selectionMethod, "fallback");
  assert.equal(new Set(result.plan.selectedArticleIds).size, result.plan.selectedArticleIds.length);
});

test("editorial fake provider with empty selection falls back to a readable Russian overview", async () => {
  const provider = new FakeProvider(completion(JSON.stringify({ overview: "Пустой выбор", selectedArticleIds: [] })));
  const result = await selectEditorialPlan(items, provider, options);
  assert.equal(result.metadata.selectionMethod, "fallback");
  assert.ok(result.plan.selectedArticleIds.length > 0);
  assert.match(result.plan.overview, /^Главное к утру:/);
});

test("editorial fake provider with malformed output falls back deterministically", async () => {
  const provider = new FakeProvider(completion("{not-json"));
  const first = await selectEditorialPlan(items, provider, options);
  const second = deterministicEditorialPlan(items, options);
  assert.equal(first.metadata.selectionMethod, "fallback");
  assert.deepEqual(first.plan, second);
});

test("editorial provider failure still produces deterministic ranking using recommendation, importance, and freshness", async () => {
  const provider = new FakeProvider(new Error("editor unavailable"));
  const result = await selectEditorialPlan(items, provider, options);

  assert.equal(result.metadata.selectionMethod, "fallback");
  assert.deepEqual(result.plan.selectedArticleIds, [2, 1, 3]);
});

test("deterministic fallback enforces topic balance and avoids near-duplicate source coverage", () => {
  const duplicate = item({
    id: 4,
    title: "Новый бюджет правительства!",
    topic: "экономика",
    summary: "Правительство представило новый бюджет и изменило основные параметры расходов.",
    importance: 94,
    recommended: true,
    publishedAt: "2026-08-29T09:55:00.000Z"
  });
  const secondEconomy = item({
    id: 5,
    title: "Центробанк опубликовал прогноз инфляции",
    topic: "экономика",
    summary: "Центробанк обновил прогноз инфляции и описал риски для цен в ближайшие месяцы.",
    importance: 90,
    recommended: true,
    publishedAt: "2026-08-29T09:50:00.000Z"
  });

  const plan = deterministicEditorialPlan([...items, duplicate, secondEconomy], {
    language: "ru",
    maxArticles: 4,
    maxPerTopic: 1
  });

  const economyIds = new Set([1, 4, 5]);
  assert.ok(plan.selectedArticleIds.filter((id) => economyIds.has(id)).length <= 1);
  assert.ok(!(plan.selectedArticleIds.includes(1) && plan.selectedArticleIds.includes(4)));
});


test("Russian editorial configuration rejects a non-Russian overview and falls back", async () => {
  const provider = new FakeProvider(completion(JSON.stringify({
    overview: "This is an English morning overview with enough words to be clearly non-Russian.",
    selectedArticleIds: [2, 1]
  })));
  const result = await selectEditorialPlan(items, provider, { ...options, maxArticles: 2 });
  assert.equal(result.metadata.selectionMethod, "fallback");
  assert.match(result.plan.overview, /^Главное к утру:/);
});

test("strict editorial schema rejects extra fields and over-limit selections", () => {
  assert.throws(
    () => parseEditorialPlan(
      JSON.stringify({ overview: "Обзор", selectedArticleIds: [1, 2], extra: true }),
      items,
      { language: "ru", maxArticles: 3, maxPerTopic: 2 }
    ),
    /schema validation/
  );
  assert.throws(
    () => parseEditorialPlan(
      JSON.stringify({ overview: "Обзор", selectedArticleIds: [1, 2, 3] }),
      items,
      { language: "ru", maxArticles: 2, maxPerTopic: 2 }
    ),
    /schema validation/
  );
});
