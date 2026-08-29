import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { AnalysisIdentity, Article, ArticleAnalysis, EditorialMetadata, EditorialPlan } from "../types.js";
import { MIGRATIONS } from "./migrations.js";

export { LATEST_SCHEMA_VERSION } from "./migrations.js";

export interface ArticleVersion {
  id: number;
  articleId: number;
  normalizedUrl: string;
  sourceId: string;
  externalId: string;
  title: string;
  author?: string;
  publishedAt: string;
  language: string;
  text: string;
  contentHtml: string;
  contentHash: string;
  fetchedAt: string;
  createdAt: string;
}

function mapArticle(row: Record<string, unknown>): Article & { id: number } {
  return {
    id: Number(row.id),
    sourceId: String(row.source_id),
    externalId: String(row.external_id),
    url: String(row.url),
    title: String(row.title),
    author: row.author === null || row.author === undefined ? undefined : String(row.author),
    publishedAt: String(row.published_at),
    language: String(row.language),
    text: String(row.text),
    contentHtml: String(row.content_html),
    contentHash: String(row.content_hash),
    fetchedAt: String(row.fetched_at)
  };
}

function mapVersion(row: Record<string, unknown>): ArticleVersion {
  return {
    id: Number(row.id),
    articleId: Number(row.article_id),
    normalizedUrl: String(row.normalized_url),
    sourceId: String(row.source_id),
    externalId: String(row.external_id),
    title: String(row.title),
    author: row.author === null || row.author === undefined ? undefined : String(row.author),
    publishedAt: String(row.published_at),
    language: String(row.language),
    text: String(row.text),
    contentHtml: String(row.content_html),
    contentHash: String(row.content_hash),
    fetchedAt: String(row.fetched_at),
    createdAt: String(row.created_at)
  };
}

function optionalInteger(value: unknown): number | undefined {
  return value === null || value === undefined ? undefined : Number(value);
}

function mapAnalysis(row: Record<string, unknown>): ArticleAnalysis {
  return {
    articleId: Number(row.article_id),
    summary: String(row.summary),
    topics: JSON.parse(String(row.topics_json)) as string[],
    importance: Number(row.importance),
    recommended: Boolean(row.recommended),
    reason: String(row.reason),
    keyFacts: JSON.parse(String(row.key_facts_json)) as string[],
    analyzedAt: String(row.analyzed_at),
    modelName: String(row.model_name),
    promptVersion: String(row.prompt_version),
    analysisVersion: String(row.analysis_version),
    latencyMs: Number(row.latency_ms),
    promptTokens: optionalInteger(row.prompt_tokens),
    completionTokens: optionalInteger(row.completion_tokens),
    totalTokens: optionalInteger(row.total_tokens)
  };
}

function earliestValidTimestamp(values: string[]): string | undefined {
  let earliest: number | undefined;
  for (const value of values) {
    const timestamp = new Date(value).getTime();
    if (Number.isNaN(timestamp)) return undefined;
    earliest = earliest === undefined ? timestamp : Math.min(earliest, timestamp);
  }
  return earliest === undefined ? undefined : new Date(earliest).toISOString();
}

export class NewsDatabase {
  private readonly db: Database.Database;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new Database(path.join(dataDir, "news.sqlite"));
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  getSchemaVersion(): number {
    const row = this.db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as
      | { version: number | null }
      | undefined;
    return Number(row?.version ?? 0);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);

    const appliedRows = this.db.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>;
    const applied = new Set(appliedRows.map((row) => Number(row.version)));
    const recordMigration = this.db.prepare(
      "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)"
    );

    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      const apply = this.db.transaction(() => {
        migration.up(this.db);
        recordMigration.run(migration.version, migration.name, new Date().toISOString());
      });
      apply();
    }
  }

  upsertArticle(article: Article): { article: Article & { id: number }; needsAnalysis: boolean } {
    const execute = this.db.transaction(() => {
      const byUrl = this.db.prepare("SELECT * FROM articles WHERE url = ?").get(article.url) as
        | Record<string, unknown>
        | undefined;
      const byExternalId = byUrl
        ? undefined
        : this.db.prepare("SELECT * FROM articles WHERE source_id = ? AND external_id = ?")
          .get(article.sourceId, article.externalId) as Record<string, unknown> | undefined;
      const existingRow = byUrl ?? byExternalId;
      const existing = existingRow ? mapArticle(existingRow) : undefined;
      const changed = !existing || existing.contentHash !== article.contentHash;

      if (!existing) {
        this.db.prepare(`
          INSERT INTO articles (
            source_id, external_id, url, title, author, published_at, language,
            text, content_html, content_hash, fetched_at
          ) VALUES (
            @sourceId, @externalId, @url, @title, @author, @publishedAt, @language,
            @text, @contentHtml, @contentHash, @fetchedAt
          )
        `).run({
          sourceId: article.sourceId,
          externalId: article.externalId,
          url: article.url,
          title: article.title,
          author: article.author ?? null,
          publishedAt: article.publishedAt,
          language: article.language,
          text: article.text,
          contentHtml: article.contentHtml,
          contentHash: article.contentHash,
          fetchedAt: article.fetchedAt
        });
      } else {
        this.db.prepare(`
          UPDATE articles SET
            source_id = @sourceId,
            external_id = @externalId,
            url = @url,
            title = @title,
            author = @author,
            published_at = @publishedAt,
            language = @language,
            text = @text,
            content_html = @contentHtml,
            content_hash = @contentHash,
            fetched_at = @fetchedAt
          WHERE id = @id
        `).run({
          id: existing.id,
          sourceId: article.sourceId,
          externalId: article.externalId,
          url: article.url,
          title: article.title,
          author: article.author ?? null,
          publishedAt: article.publishedAt,
          language: article.language,
          text: article.text,
          contentHtml: article.contentHtml,
          contentHash: article.contentHash,
          fetchedAt: article.fetchedAt
        });
      }

      const storedRow = existing
        ? this.db.prepare("SELECT * FROM articles WHERE id = ?").get(existing.id) as Record<string, unknown>
        : this.db.prepare("SELECT * FROM articles WHERE url = ?").get(article.url) as Record<string, unknown>;
      const stored = mapArticle(storedRow);

      this.db.prepare(`
        INSERT OR IGNORE INTO article_versions (
          article_id, normalized_url, source_id, external_id, title, author,
          published_at, language, text, content_html, content_hash, fetched_at, created_at
        ) VALUES (
          @articleId, @normalizedUrl, @sourceId, @externalId, @title, @author,
          @publishedAt, @language, @text, @contentHtml, @contentHash, @fetchedAt, @createdAt
        )
      `).run({
        articleId: stored.id,
        normalizedUrl: stored.url,
        sourceId: stored.sourceId,
        externalId: stored.externalId,
        title: stored.title,
        author: stored.author ?? null,
        publishedAt: stored.publishedAt,
        language: stored.language,
        text: stored.text,
        contentHtml: stored.contentHtml,
        contentHash: stored.contentHash,
        fetchedAt: stored.fetchedAt,
        createdAt: stored.fetchedAt
      });

      if (existing && changed) {
        this.db.prepare("DELETE FROM analyses WHERE article_id = ?").run(stored.id);
      }

      return {
        article: stored,
        needsAnalysis: changed || !this.getAnalysis(stored.id)
      };
    });

    return execute();
  }

  getArticleByUrl(url: string): (Article & { id: number }) | undefined {
    const row = this.db.prepare("SELECT * FROM articles WHERE url = ?").get(url) as Record<string, unknown> | undefined;
    return row ? mapArticle(row) : undefined;
  }

  getArticleVersions(articleId: number): ArticleVersion[] {
    const rows = this.db.prepare(`
      SELECT * FROM article_versions WHERE article_id = ? ORDER BY id ASC
    `).all(articleId) as Array<Record<string, unknown>>;
    return rows.map(mapVersion);
  }

  getAnalysis(articleId: number, identity?: AnalysisIdentity): ArticleAnalysis | undefined {
    const row = identity
      ? this.db.prepare(`
          SELECT * FROM analyses
          WHERE article_id = ? AND model_name = ? AND prompt_version = ? AND analysis_version = ?
        `).get(articleId, identity.modelName, identity.promptVersion, identity.analysisVersion) as Record<string, unknown> | undefined
      : this.db.prepare("SELECT * FROM analyses WHERE article_id = ?").get(articleId) as Record<string, unknown> | undefined;
    return row ? mapAnalysis(row) : undefined;
  }

  saveAnalysis(analysis: ArticleAnalysis): void {
    this.db.prepare(`
      INSERT INTO analyses (
        article_id, summary, topics_json, importance, recommended, reason, key_facts_json, analyzed_at,
        model_name, prompt_version, analysis_version, latency_ms, prompt_tokens, completion_tokens, total_tokens
      ) VALUES (
        @articleId, @summary, @topicsJson, @importance, @recommended, @reason, @keyFactsJson, @analyzedAt,
        @modelName, @promptVersion, @analysisVersion, @latencyMs, @promptTokens, @completionTokens, @totalTokens
      )
      ON CONFLICT(article_id) DO UPDATE SET
        summary = excluded.summary,
        topics_json = excluded.topics_json,
        importance = excluded.importance,
        recommended = excluded.recommended,
        reason = excluded.reason,
        key_facts_json = excluded.key_facts_json,
        analyzed_at = excluded.analyzed_at,
        model_name = excluded.model_name,
        prompt_version = excluded.prompt_version,
        analysis_version = excluded.analysis_version,
        latency_ms = excluded.latency_ms,
        prompt_tokens = excluded.prompt_tokens,
        completion_tokens = excluded.completion_tokens,
        total_tokens = excluded.total_tokens
    `).run({
      articleId: analysis.articleId,
      summary: analysis.summary,
      topicsJson: JSON.stringify(analysis.topics),
      importance: analysis.importance,
      recommended: analysis.recommended ? 1 : 0,
      reason: analysis.reason,
      keyFactsJson: JSON.stringify(analysis.keyFacts),
      analyzedAt: analysis.analyzedAt,
      modelName: analysis.modelName,
      promptVersion: analysis.promptVersion,
      analysisVersion: analysis.analysisVersion,
      latencyMs: analysis.latencyMs,
      promptTokens: analysis.promptTokens ?? null,
      completionTokens: analysis.completionTokens ?? null,
      totalTokens: analysis.totalTokens ?? null
    });
  }

  saveEdition(
    editionDate: string,
    plan: EditorialPlan,
    outputPath: string,
    metadata: EditorialMetadata = { modelName: "legacy", promptVersion: "legacy", selectionMethod: "fallback" }
  ): void {
    const save = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO editions (
          edition_date, overview, selected_article_ids_json, output_path, created_at,
          editorial_model_name, editorial_prompt_version, editorial_selection_method
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(edition_date) DO UPDATE SET
          overview = excluded.overview,
          selected_article_ids_json = excluded.selected_article_ids_json,
          output_path = excluded.output_path,
          created_at = excluded.created_at,
          editorial_model_name = excluded.editorial_model_name,
          editorial_prompt_version = excluded.editorial_prompt_version,
          editorial_selection_method = excluded.editorial_selection_method
      `).run(
        editionDate,
        plan.overview,
        JSON.stringify(plan.selectedArticleIds),
        outputPath,
        new Date().toISOString(),
        metadata.modelName,
        metadata.promptVersion,
        metadata.selectionMethod
      );

      this.db.prepare("DELETE FROM edition_articles WHERE edition_date = ?").run(editionDate);
      const insertMembership = this.db.prepare(`
        INSERT INTO edition_articles (edition_date, article_id, position) VALUES (?, ?, ?)
      `);
      const seen = new Set<number>();
      let position = 0;
      for (const articleId of plan.selectedArticleIds) {
        if (seen.has(articleId)) continue;
        insertMembership.run(editionDate, articleId, position);
        seen.add(articleId);
        position += 1;
      }
    });
    save();
  }

  getEditionArticleIds(editionDate: string): number[] {
    const rows = this.db.prepare(`
      SELECT article_id FROM edition_articles WHERE edition_date = ? ORDER BY position ASC
    `).all(editionDate) as Array<{ article_id: number }>;
    return rows.map((row) => Number(row.article_id));
  }

  getEditionEditorialMetadata(editionDate: string): EditorialMetadata | undefined {
    const row = this.db.prepare(`
      SELECT editorial_model_name, editorial_prompt_version, editorial_selection_method
      FROM editions WHERE edition_date = ?
    `).get(editionDate) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const selectionMethod = String(row.editorial_selection_method);
    return {
      modelName: String(row.editorial_model_name),
      promptVersion: String(row.editorial_prompt_version),
      selectionMethod: selectionMethod === "llm" ? "llm" : "fallback"
    };
  }

  getSourceCheckpoint(sourceId: string): string | undefined {
    const row = this.db.prepare("SELECT last_run_at FROM source_state WHERE source_id = ?").get(sourceId) as
      | { last_run_at: string }
      | undefined;
    return row?.last_run_at;
  }

  recordSourceRunCompletion(sourceId: string, runStartedAt: string, failedPublishedAt: string[] = []): string | undefined {
    const target = failedPublishedAt.length > 0 ? earliestValidTimestamp(failedPublishedAt) : new Date(runStartedAt).toISOString();
    if (!target) return this.getSourceCheckpoint(sourceId);

    this.db.prepare(`
      INSERT INTO source_state (source_id, last_run_at) VALUES (?, ?)
      ON CONFLICT(source_id) DO UPDATE SET last_run_at = CASE
        WHEN excluded.last_run_at > source_state.last_run_at THEN excluded.last_run_at
        ELSE source_state.last_run_at
      END
    `).run(sourceId, target);
    return this.getSourceCheckpoint(sourceId);
  }
}
