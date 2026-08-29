import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { Article, ArticleAnalysis, EditorialPlan } from "../types.js";

export class NewsDatabase {
  private readonly db: Database.Database;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new Database(path.join(dataDir, "news.sqlite"));
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS articles (
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

      CREATE TABLE IF NOT EXISTS analyses (
        article_id INTEGER PRIMARY KEY,
        summary TEXT NOT NULL,
        topics_json TEXT NOT NULL,
        importance INTEGER NOT NULL,
        recommended INTEGER NOT NULL,
        reason TEXT NOT NULL,
        key_facts_json TEXT NOT NULL,
        analyzed_at TEXT NOT NULL,
        FOREIGN KEY(article_id) REFERENCES articles(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS editions (
        edition_date TEXT PRIMARY KEY,
        overview TEXT NOT NULL,
        selected_article_ids_json TEXT NOT NULL,
        output_path TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS source_state (
        source_id TEXT PRIMARY KEY,
        last_run_at TEXT NOT NULL
      );
    `);
  }

  upsertArticle(article: Article): { article: Article & { id: number }; needsAnalysis: boolean } {
    const existing = this.db.prepare("SELECT id, content_hash FROM articles WHERE url = ?").get(article.url) as
      | { id: number; content_hash: string }
      | undefined;

    const changed = !existing || existing.content_hash !== article.contentHash;
    this.db.prepare(`
      INSERT INTO articles (source_id, external_id, url, title, author, published_at, language, text, content_html, content_hash, fetched_at)
      VALUES (@sourceId, @externalId, @url, @title, @author, @publishedAt, @language, @text, @contentHtml, @contentHash, @fetchedAt)
      ON CONFLICT(url) DO UPDATE SET
        external_id = excluded.external_id,
        title = excluded.title,
        author = excluded.author,
        published_at = excluded.published_at,
        language = excluded.language,
        text = excluded.text,
        content_html = excluded.content_html,
        content_hash = excluded.content_hash,
        fetched_at = excluded.fetched_at
    `).run(article);

    const row = this.db.prepare("SELECT id FROM articles WHERE url = ?").get(article.url) as { id: number };
    if (existing && changed) this.db.prepare("DELETE FROM analyses WHERE article_id = ?").run(row.id);
    return { article: { ...article, id: row.id }, needsAnalysis: changed || !this.getAnalysis(row.id) };
  }

  getAnalysis(articleId: number): ArticleAnalysis | undefined {
    const row = this.db.prepare("SELECT * FROM analyses WHERE article_id = ?").get(articleId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      articleId: Number(row.article_id),
      summary: String(row.summary),
      topics: JSON.parse(String(row.topics_json)) as string[],
      importance: Number(row.importance),
      recommended: Boolean(row.recommended),
      reason: String(row.reason),
      keyFacts: JSON.parse(String(row.key_facts_json)) as string[],
      analyzedAt: String(row.analyzed_at)
    };
  }

  saveAnalysis(analysis: ArticleAnalysis): void {
    this.db.prepare(`
      INSERT INTO analyses (article_id, summary, topics_json, importance, recommended, reason, key_facts_json, analyzed_at)
      VALUES (@articleId, @summary, @topicsJson, @importance, @recommended, @reason, @keyFactsJson, @analyzedAt)
      ON CONFLICT(article_id) DO UPDATE SET
        summary = excluded.summary,
        topics_json = excluded.topics_json,
        importance = excluded.importance,
        recommended = excluded.recommended,
        reason = excluded.reason,
        key_facts_json = excluded.key_facts_json,
        analyzed_at = excluded.analyzed_at
    `).run({
      ...analysis,
      recommended: analysis.recommended ? 1 : 0,
      topicsJson: JSON.stringify(analysis.topics),
      keyFactsJson: JSON.stringify(analysis.keyFacts)
    });
  }

  saveEdition(editionDate: string, plan: EditorialPlan, outputPath: string): void {
    this.db.prepare(`
      INSERT INTO editions (edition_date, overview, selected_article_ids_json, output_path, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(edition_date) DO UPDATE SET
        overview = excluded.overview,
        selected_article_ids_json = excluded.selected_article_ids_json,
        output_path = excluded.output_path,
        created_at = excluded.created_at
    `).run(editionDate, plan.overview, JSON.stringify(plan.selectedArticleIds), outputPath, new Date().toISOString());
  }

  getSourceLastRun(sourceId: string): string | undefined {
    const row = this.db.prepare("SELECT last_run_at FROM source_state WHERE source_id = ?").get(sourceId) as { last_run_at: string } | undefined;
    return row?.last_run_at;
  }

  setSourceLastRun(sourceId: string, timestamp: string): void {
    this.db.prepare(`
      INSERT INTO source_state (source_id, last_run_at) VALUES (?, ?)
      ON CONFLICT(source_id) DO UPDATE SET last_run_at = excluded.last_run_at
    `).run(sourceId, timestamp);
  }
}
