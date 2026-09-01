import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { checkSourceConfiguration } from "../src/doctor.js";
import { parseConfig } from "../src/config.js";
import { deterministicEditorialPlan, validateEditorialPlan } from "../src/llm/editorial.js";
import type { LlmCompletion, LlmMessage, LlmProvider } from "../src/llm/provider.js";
import { contentAnalysisPrompt, DISCUSSION_ANALYSIS_PROMPT_VERSION } from "../src/llm/prompts.js";
import { runPipeline } from "../src/pipeline.js";
import type { EditionRenderer, RenderEditionRequest, RenderedEdition } from "../src/rendering/renderer.js";
import type { RedditClient } from "../src/sources/reddit-client.js";
import { defaultRedditSettings, redditSourceId, RedditSource } from "../src/sources/reddit.js";
import { createDefaultSourceRegistry } from "../src/sources/registry.js";
import { SourceConfigService } from "../src/sources/service.js";
import { SourceConfigRepository } from "../src/storage/source-config.js";
import type { Article, EditionArticle } from "../src/types.js";

class CapturingProvider implements LlmProvider {
  prompts: string[] = [];
  async complete(messages: LlmMessage[]): Promise<LlmCompletion> {
    const prompt = messages.at(-1)?.content ?? "";
    this.prompts.push(prompt);
    if (prompt.includes("selectedArticleIds")) throw new Error("force fallback");
    return {
      model: "fake",
      latencyMs: 1,
      content: JSON.stringify({
        summary: "The discussion compares two approaches and highlights trade-offs.",
        topics: ["self-hosting"],
        importance: 70,
        recommended: true,
        reason: "Useful practical discussion",
        keyPoints: ["Participants prefer different approaches for different constraints."]
      })
    };
  }
}

class CapturingRenderer implements EditionRenderer {
  request?: RenderEditionRequest;
  async render(request: RenderEditionRequest): Promise<RenderedEdition> {
    this.request = request;
    return { epubPath: "/tmp/latest.epub", manifestPath: "/tmp/latest.json" };
  }
}

class PipelineRedditClient {
  async getJson<T>(pathName: string): Promise<T> {
    const now = Date.now() / 1_000;
    if (pathName.includes("/new")) {
      return {
        data: {
          after: null,
          children: [{
            kind: "t3",
            data: {
              id: "abc123",
              name: "t3_abc123",
              title: "Which self-hosting approach is more reliable?",
              permalink: "/r/selfhosted/comments/abc123/example/",
              created_utc: now,
              score: 120,
              num_comments: 35,
              upvote_ratio: 0.94,
              stickied: false,
              over_18: false,
              is_self: true,
              selftext: "The poster compares two deployment approaches.",
              author: "original_poster"
            }
          }]
        }
      } as T;
    }
    return [
      { data: { children: [{ kind: "t3", data: { selftext: "The poster compares two deployment approaches." } }] } },
      { data: { children: [
        { kind: "t1", data: { id: "c1", author: "alice_private", body: "SECRET-COMMENT-ONE favors option A." } },
        { kind: "t1", data: { id: "c2", author: "bob_private", body: "SECRET-COMMENT-TWO favors option B." } }
      ] } }
    ] as T;
  }
}

function redditAppConfig(dataDir: string, overrides: Record<string, string> = {}) {
  return parseConfig({
    DATA_DIR: dataDir,
    OUTPUT_DIR: path.join(dataDir, "public", "daily"),
    LLM_MODEL: "fake-model",
    LLM_BASE_URL: "http://gaming-rig.home.arpa:11434",
    EDITION_LANGUAGE: "en",
    ARTICLE_FETCH_DELAY_MS: "0",
    REDDIT_CLIENT_ID: "client",
    REDDIT_CLIENT_SECRET: "secret",
    REDDIT_USER_AGENT: "linux:ai-news-assistant:0.1 (by /u/testowner)",
    ...overrides
  });
}

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "ai-news-reddit-integration-"));
}

test("Reddit source configuration is GUI-ready, duplicate-safe, and credentials are only required when Reddit is enabled", async () => {
  const dataDir = await tempDir();
  try {
    const registry = createDefaultSourceRegistry();
    const repository = new SourceConfigRepository(dataDir);
    try {
      const service = new SourceConfigService(repository, registry, () => new Date("2026-09-01T10:00:00Z"));
      service.bootstrapDefaultMeduza("https://meduza.io/rss/all");
      const created = service.create({
        id: "reddit:selfhosted",
        type: "reddit",
        displayName: "r/selfhosted",
        settings: defaultRedditSettings("selfhosted")
      });
      assert.equal(created.settings.subreddit, "selfhosted");
      assert.equal(created.enabled, true);
      assert.throws(() => service.create({
        id: "reddit:selfhosted",
        type: "reddit",
        settings: defaultRedditSettings("selfhosted")
      }), /already exists/);
      assert.throws(() => service.create({
        id: "reddit:homelab",
        type: "reddit",
        settings: defaultRedditSettings("selfhosted")
      }), /expected reddit:selfhosted/);
    } finally {
      repository.close();
    }

    const missingCredentials = checkSourceConfiguration(parseConfig({ DATA_DIR: dataDir, LLM_MODEL: "fake" }), registry);
    assert.equal(missingCredentials.ok, false);
    assert.match(missingCredentials.detail, /REDDIT_CLIENT_ID/);

    const repository2 = new SourceConfigRepository(dataDir);
    try {
      new SourceConfigService(repository2, registry).setEnabled("reddit:selfhosted", false);
    } finally {
      repository2.close();
    }
    const meduzaOnly = checkSourceConfiguration(parseConfig({ DATA_DIR: dataDir, LLM_MODEL: "fake" }), registry);
    assert.equal(meduzaOnly.ok, true);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("Reddit pipeline analyzes the in-memory snapshot but never persists raw comments or usernames", async () => {
  const dataDir = await tempDir();
  try {
    const config = redditAppConfig(dataDir);
    const source = new RedditSource(config, {
      id: redditSourceId("selfhosted"),
      type: "reddit",
      enabled: true,
      displayName: "r/selfhosted",
      settingsVersion: 1,
      settings: defaultRedditSettings("selfhosted"),
      createdAt: "2026-09-01T00:00:00Z",
      updatedAt: "2026-09-01T00:00:00Z"
    }, { client: new PipelineRedditClient() as unknown as RedditClient });
    const provider = new CapturingProvider();
    const renderer = new CapturingRenderer();

    const result = await runPipeline(config, source, provider, renderer);
    assert.equal(result.selectedCount, 1);
    const analysisPrompt = provider.prompts.find((prompt) => prompt.includes("SECRET-COMMENT-ONE"));
    assert.ok(analysisPrompt, "the LLM should analyze the bounded in-memory discussion snapshot");
    assert.doesNotMatch(analysisPrompt, /alice_private|bob_private/);

    const selected = renderer.request?.selected[0]?.article;
    assert.equal(selected?.contentKind, "discussion");
    assert.equal(selected?.text, "[Reddit discussion snapshot discarded after analysis]");
    assert.equal(selected?.sourceContext.subreddit, "selfhosted");

    const sqlite = new Database(path.join(dataDir, "news.sqlite"), { readonly: true });
    try {
      const articles = JSON.stringify(sqlite.prepare("SELECT text, content_html, source_context_json FROM articles").all());
      const versions = JSON.stringify(sqlite.prepare("SELECT text, content_html FROM article_versions").all());
      for (const raw of [articles, versions]) {
        assert.doesNotMatch(raw, /SECRET-COMMENT-ONE|SECRET-COMMENT-TWO|alice_private|bob_private|original_poster/);
      }
      assert.match(articles, /snapshot discarded after analysis/);
    } finally {
      sqlite.close();
    }
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

function editorialItem(id: number, sourceId: string, contentKind: "article" | "discussion", importance: number): EditionArticle {
  return {
    article: {
      id,
      sourceId,
      externalId: `item-${id}`,
      url: `https://example.test/${id}`,
      title: `Distinct item ${id}`,
      publishedAt: `2026-09-01T${String(10 + id).padStart(2, "0")}:00:00Z`,
      language: "en",
      contentKind,
      sourceContext: contentKind === "discussion" ? { subreddit: sourceId.replace("reddit:", "") } : {},
      text: "content",
      contentHtml: "",
      contentHash: `hash-${id}`,
      fetchedAt: "2026-09-01T12:00:00Z"
    },
    analysis: {
      articleId: id,
      summary: `Unique summary for item ${id}`,
      topics: [`topic-${id}`],
      importance,
      recommended: true,
      reason: `reason-${id}`,
      keyPoints: [`point-${id}`],
      analyzedAt: "2026-09-01T12:00:00Z",
      modelName: "fake",
      promptVersion: "fixture",
      analysisVersion: "fixture",
      latencyMs: 1
    }
  } as EditionArticle;
}

test("editorial validation and deterministic fallback enforce the edition-wide discussion cap", () => {
  const items = [
    editorialItem(1, "reddit:selfhosted", "discussion", 100),
    editorialItem(2, "reddit:homelab", "discussion", 99),
    editorialItem(3, "meduza", "article", 80),
    editorialItem(4, "meduza:alt", "article", 70)
  ];
  const options = { language: "en", maxArticles: 4, maxPerTopic: 4, maxPerSource: 4, maxDiscussions: 1 };
  assert.throws(
    () => validateEditorialPlan({ overview: "Overview", selectedArticleIds: [1, 2, 3] }, items, options),
    /Editorial plan output failed schema validation/
  );
  const fallback = deterministicEditorialPlan(items, options);
  const selected = new Set(fallback.selectedArticleIds);
  assert.equal([1, 2].filter((id) => selected.has(id)).length, 1);
  assert.ok(selected.has(3));
});

test("discussion analysis prompt is versioned, neutral about claims, and strips username-like context", () => {
  const article: Article = {
    sourceId: "reddit:selfhosted",
    externalId: "t3_abc",
    url: "https://www.reddit.com/r/selfhosted/comments/abc/example/",
    title: "Example",
    publishedAt: "2026-09-01T10:00:00Z",
    language: "en",
    contentKind: "discussion",
    sourceContext: { subreddit: "selfhosted", username: "should-not-appear", score: 20 },
    text: "Comment 1: a participant claims X.\n\nComment 2: another participant disagrees.",
    contentHtml: "",
    contentHash: "hash",
    fetchedAt: "2026-09-01T10:01:00Z"
  };
  const prompt = contentAnalysisPrompt(article, "en");
  assert.match(prompt, new RegExp(DISCUSSION_ANALYSIS_PROMPT_VERSION));
  assert.match(prompt, /NOT verified facts/);
  assert.match(prompt, /Do not infer community consensus/);
  assert.doesNotMatch(prompt, /should-not-appear/);
});