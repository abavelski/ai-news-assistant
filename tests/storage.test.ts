import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { ARTICLE_ANALYSIS_VERSION } from "../src/llm/article-analysis.js";
import { ARTICLE_ANALYSIS_PROMPT_VERSION } from "../src/llm/prompts.js";
import { LATEST_SCHEMA_VERSION, NewsDatabase } from "../src/storage/sqlite.js";
import type { AnalysisIdentity, Article, ArticleAnalysis } from "../src/types.js";
import { sha256 } from "../src/utils/hash.js";

function article(overrides: Partial<Article> = {}): Article {
  const text = overrides.text ?? "A sufficiently long normalized article body for storage tests.";
  return {
    sourceId: "meduza",
    externalId: "article-1",
    url: "https://meduza.io/feature/2026/08/29/storage-test",
    title: "Storage test",
    author: "Test Author",
    publishedAt: "2026-08-29T08:00:00.000Z",
    language: "ru",
    text,
    contentHtml: overrides.contentHtml ?? `<p>${text}</p>`,
    contentHash: overrides.contentHash ?? sha256(text),
    fetchedAt: overrides.fetchedAt ?? "2026-08-29T08:05:00.000Z",
    ...overrides
  };
}

const identity: AnalysisIdentity = {
  modelName: "model-a",
  promptVersion: ARTICLE_ANALYSIS_PROMPT_VERSION,
  analysisVersion: ARTICLE_ANALYSIS_VERSION
};

function analysis(articleId: number, overrides: Partial<ArticleAnalysis> = {}): ArticleAnalysis {
  return {
    articleId,
    summary: "summary",
    topics: ["test"],
    importance: 50,
    recommended: true,
    reason: "reason",
    keyFacts: ["fact"],
    analyzedAt: "2026-08-29T08:06:00.000Z",
    ...identity,
    latencyMs: 123,
    promptTokens: 100,
    completionTokens: 20,
    totalTokens: 120,
    ...overrides
  };
}

async function withTempDatabase(run: (dataDir: string) => Promise<void> | void): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ai-news-storage-"));
  try {
    await run(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("migrations initialize an empty database at the latest schema version", async () => {
  await withTempDatabase((dataDir) => {
    const db = new NewsDatabase(dataDir);
    try {
      assert.equal(db.getSchemaVersion(), LATEST_SCHEMA_VERSION);
      assert.equal(LATEST_SCHEMA_VERSION, 3);
    } finally {
      db.close();
    }
  });
});

test("identical article upserts are idempotent and create one version", async () => {
  await withTempDatabase((dataDir) => {
    const db = new NewsDatabase(dataDir);
    try {
      const first = db.upsertArticle(article());
      const second = db.upsertArticle(article({ fetchedAt: "2026-08-29T08:10:00.000Z" }));
      const canonicalized = db.upsertArticle(article({
        url: "https://meduza.io/feature/2026/08/29/storage-test-canonical",
        fetchedAt: "2026-08-29T08:15:00.000Z"
      }));

      assert.equal(first.article.id, second.article.id);
      assert.equal(first.article.id, canonicalized.article.id);
      assert.equal(db.getArticleVersions(first.article.id).length, 1);
      assert.equal(db.getArticleByUrl(canonicalized.article.url)?.id, first.article.id);
      assert.equal(db.getArticleByUrl(first.article.url), undefined);
    } finally {
      db.close();
    }
  });
});

test("analysis cache requires matching model, prompt, and analysis versions", async () => {
  await withTempDatabase((dataDir) => {
    const db = new NewsDatabase(dataDir);
    try {
      const stored = db.upsertArticle(article()).article;
      db.saveAnalysis(analysis(stored.id));

      assert.equal(db.getAnalysis(stored.id, identity)?.summary, "summary");
      assert.equal(db.getAnalysis(stored.id, { ...identity, modelName: "model-b" }), undefined);
      assert.equal(db.getAnalysis(stored.id, { ...identity, promptVersion: "article-analysis-v2" }), undefined);
      assert.equal(db.getAnalysis(stored.id, { ...identity, analysisVersion: "schema-v2" }), undefined);
      assert.equal(db.getAnalysis(stored.id)?.totalTokens, 120);
    } finally {
      db.close();
    }
  });
});

test("changed content creates a history version and invalidates stale analysis atomically", async () => {
  await withTempDatabase((dataDir) => {
    const db = new NewsDatabase(dataDir);
    try {
      const first = db.upsertArticle(article());
      db.saveAnalysis(analysis(first.article.id));
      assert.ok(db.getAnalysis(first.article.id));

      const changedText = "A changed article body that should be retained as a second immutable content version.";
      const second = db.upsertArticle(article({
        text: changedText,
        contentHtml: `<p>${changedText}</p>`,
        contentHash: sha256(changedText),
        fetchedAt: "2026-08-29T09:00:00.000Z"
      }));

      assert.equal(second.article.id, first.article.id);
      assert.equal(second.needsAnalysis, true);
      assert.equal(db.getAnalysis(first.article.id), undefined);
      const versions = db.getArticleVersions(first.article.id);
      assert.equal(versions.length, 2);
      assert.deepEqual(versions.map((version) => version.contentHash), [first.article.contentHash, second.article.contentHash]);
    } finally {
      db.close();
    }
  });
});

test("source checkpoints stop at the earliest failed item and never move backwards", async () => {
  await withTempDatabase((dataDir) => {
    const db = new NewsDatabase(dataDir);
    try {
      const partial = db.recordSourceRunCompletion(
        "meduza",
        "2026-08-29T10:00:00.000Z",
        ["2026-08-29T09:40:00.000Z", "2026-08-29T09:20:00.000Z"]
      );
      assert.equal(partial, "2026-08-29T09:20:00.000Z");

      const attemptedRegression = db.recordSourceRunCompletion(
        "meduza",
        "2026-08-29T10:30:00.000Z",
        ["2026-08-29T09:10:00.000Z"]
      );
      assert.equal(attemptedRegression, "2026-08-29T09:20:00.000Z");

      const complete = db.recordSourceRunCompletion("meduza", "2026-08-29T11:00:00.000Z");
      assert.equal(complete, "2026-08-29T11:00:00.000Z");
    } finally {
      db.close();
    }
  });
});

test("edition membership is stored relationally in editorial order", async () => {
  await withTempDatabase((dataDir) => {
    const db = new NewsDatabase(dataDir);
    try {
      const one = db.upsertArticle(article({ externalId: "one", url: "https://meduza.io/feature/one" })).article;
      const twoText = "Another sufficiently long body for the second edition membership article.";
      const two = db.upsertArticle(article({
        externalId: "two",
        url: "https://meduza.io/feature/two",
        text: twoText,
        contentHtml: `<p>${twoText}</p>`,
        contentHash: sha256(twoText)
      })).article;

      db.saveEdition(
        "2026-08-29",
        { overview: "overview", selectedArticleIds: [two.id, two.id, one.id] },
        "/tmp/latest.epub"
      );
      assert.deepEqual(db.getEditionArticleIds("2026-08-29"), [two.id, one.id]);
    } finally {
      db.close();
    }
  });
});

test("migration upgrades the legacy schema and marks old analysis metadata as legacy", async () => {
  await withTempDatabase((dataDir) => {
    const dbPath = path.join(dataDir, "news.sqlite");
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE articles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id TEXT NOT NULL,
        external_id TEXT NOT NULL,
        url TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        author TEXT,
        published_at TEXT NOT NULL,
        language TEXT NOT NULL,
        text TEXT NOT NULL,
        content_html TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        UNIQUE(source_id, external_id)
      );
      CREATE TABLE analyses (
        article_id INTEGER PRIMARY KEY,
        summary TEXT NOT NULL,
        topics_json TEXT NOT NULL,
        importance INTEGER NOT NULL,
        recommended INTEGER NOT NULL,
        reason TEXT NOT NULL,
        key_facts_json TEXT NOT NULL,
        analyzed_at TEXT NOT NULL
      );
      CREATE TABLE editions (
        edition_date TEXT PRIMARY KEY,
        overview TEXT NOT NULL,
        selected_article_ids_json TEXT NOT NULL,
        output_path TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE source_state (
        source_id TEXT PRIMARY KEY,
        last_run_at TEXT NOT NULL
      );
    `);
    const legacyArticle = article();
    legacy.prepare(`
      INSERT INTO articles (
        source_id, external_id, url, title, author, published_at, language,
        text, content_html, content_hash, fetched_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      legacyArticle.sourceId,
      legacyArticle.externalId,
      legacyArticle.url,
      legacyArticle.title,
      legacyArticle.author ?? null,
      legacyArticle.publishedAt,
      legacyArticle.language,
      legacyArticle.text,
      legacyArticle.contentHtml,
      legacyArticle.contentHash,
      legacyArticle.fetchedAt
    );
    const row = legacy.prepare("SELECT id FROM articles WHERE url = ?").get(legacyArticle.url) as { id: number };
    legacy.prepare(`INSERT INTO analyses VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.id, "legacy summary", "[\"legacy\"]", 75, 1, "legacy reason", "[\"legacy fact\"]", "2026-08-29T08:06:00.000Z");
    legacy.prepare("INSERT INTO editions VALUES (?, ?, ?, ?, ?)").run(
      "2026-08-29",
      "legacy overview",
      JSON.stringify([row.id]),
      "/legacy/latest.epub",
      "2026-08-29T08:07:00.000Z"
    );
    legacy.prepare("INSERT INTO source_state VALUES (?, ?)").run("meduza", "2026-08-29T08:08:00.000Z");
    legacy.close();

    const upgraded = new NewsDatabase(dataDir);
    try {
      assert.equal(upgraded.getSchemaVersion(), LATEST_SCHEMA_VERSION);
      assert.equal(upgraded.getArticleVersions(row.id).length, 1);
      const migrated = upgraded.getAnalysis(row.id);
      assert.equal(migrated?.summary, "legacy summary");
      assert.equal(migrated?.modelName, "legacy");
      assert.equal(migrated?.promptVersion, "legacy");
      assert.equal(migrated?.analysisVersion, "legacy");
      assert.equal(migrated?.latencyMs, 0);
      assert.equal(upgraded.getAnalysis(row.id, identity), undefined);
      assert.deepEqual(upgraded.getEditionArticleIds("2026-08-29"), [row.id]);
      assert.equal(upgraded.getSourceCheckpoint("meduza"), "2026-08-29T08:08:00.000Z");
    } finally {
      upgraded.close();
    }
  });
});
