import type Database from "better-sqlite3";

export interface Migration {
  version: number;
  name: string;
  up(db: Database.Database): void;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "001_initial_schema",
    up(db) {
      db.exec(`
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
  },
  {
    version: 2,
    name: "002_article_versions_and_indexes",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS article_versions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          article_id INTEGER NOT NULL,
          normalized_url TEXT NOT NULL,
          source_id TEXT NOT NULL,
          external_id TEXT NOT NULL,
          title TEXT NOT NULL,
          author TEXT,
          published_at TEXT NOT NULL,
          language TEXT NOT NULL,
          text TEXT NOT NULL,
          content_html TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          fetched_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY(article_id) REFERENCES articles(id) ON DELETE CASCADE,
          UNIQUE(article_id, content_hash),
          UNIQUE(normalized_url, content_hash)
        );

        CREATE TABLE IF NOT EXISTS edition_articles (
          edition_date TEXT NOT NULL,
          article_id INTEGER NOT NULL,
          position INTEGER NOT NULL,
          PRIMARY KEY(edition_date, article_id),
          UNIQUE(edition_date, position),
          FOREIGN KEY(edition_date) REFERENCES editions(edition_date) ON DELETE CASCADE,
          FOREIGN KEY(article_id) REFERENCES articles(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_articles_source_id ON articles(source_id);
        CREATE INDEX IF NOT EXISTS idx_articles_published_at ON articles(published_at);
        CREATE INDEX IF NOT EXISTS idx_articles_source_published ON articles(source_id, published_at);
        CREATE INDEX IF NOT EXISTS idx_articles_content_hash ON articles(content_hash);
        CREATE INDEX IF NOT EXISTS idx_article_versions_article_id ON article_versions(article_id);
        CREATE INDEX IF NOT EXISTS idx_article_versions_content_hash ON article_versions(content_hash);
        CREATE INDEX IF NOT EXISTS idx_edition_articles_article_id ON edition_articles(article_id);
      `);

      const legacyArticles = db.prepare(`
        SELECT id, source_id, external_id, url, title, author, published_at, language,
               text, content_html, content_hash, fetched_at
        FROM articles
      `).all() as Array<Record<string, unknown>>;
      const insertVersion = db.prepare(`
        INSERT OR IGNORE INTO article_versions (
          article_id, normalized_url, source_id, external_id, title, author,
          published_at, language, text, content_html, content_hash, fetched_at, created_at
        ) VALUES (
          @articleId, @normalizedUrl, @sourceId, @externalId, @title, @author,
          @publishedAt, @language, @text, @contentHtml, @contentHash, @fetchedAt, @createdAt
        )
      `);
      for (const row of legacyArticles) {
        insertVersion.run({
          articleId: Number(row.id),
          normalizedUrl: String(row.url),
          sourceId: String(row.source_id),
          externalId: String(row.external_id),
          title: String(row.title),
          author: row.author === null || row.author === undefined ? null : String(row.author),
          publishedAt: String(row.published_at),
          language: String(row.language),
          text: String(row.text),
          contentHtml: String(row.content_html),
          contentHash: String(row.content_hash),
          fetchedAt: String(row.fetched_at),
          createdAt: String(row.fetched_at)
        });
      }

      const editions = db.prepare("SELECT edition_date, selected_article_ids_json FROM editions").all() as Array<{
        edition_date: string;
        selected_article_ids_json: string;
      }>;
      const articleExists = db.prepare("SELECT 1 AS ok FROM articles WHERE id = ?");
      const insertMembership = db.prepare(`
        INSERT OR IGNORE INTO edition_articles (edition_date, article_id, position)
        VALUES (?, ?, ?)
      `);
      for (const edition of editions) {
        let ids: unknown;
        try {
          ids = JSON.parse(edition.selected_article_ids_json) as unknown;
        } catch {
          continue;
        }
        if (!Array.isArray(ids)) continue;
        const seen = new Set<number>();
        let position = 0;
        for (const value of ids) {
          const articleId = Number(value);
          if (!Number.isSafeInteger(articleId) || seen.has(articleId) || !articleExists.get(articleId)) continue;
          insertMembership.run(edition.edition_date, articleId, position);
          seen.add(articleId);
          position += 1;
        }
      }
    }
  },
  {
    version: 3,
    name: "003_versioned_analysis_metadata",
    up(db) {
      db.exec(`
        ALTER TABLE analyses ADD COLUMN model_name TEXT NOT NULL DEFAULT 'legacy';
        ALTER TABLE analyses ADD COLUMN prompt_version TEXT NOT NULL DEFAULT 'legacy';
        ALTER TABLE analyses ADD COLUMN analysis_version TEXT NOT NULL DEFAULT 'legacy';
        ALTER TABLE analyses ADD COLUMN latency_ms INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE analyses ADD COLUMN prompt_tokens INTEGER;
        ALTER TABLE analyses ADD COLUMN completion_tokens INTEGER;
        ALTER TABLE analyses ADD COLUMN total_tokens INTEGER;
        CREATE INDEX IF NOT EXISTS idx_analyses_cache_identity
          ON analyses(article_id, model_name, prompt_version, analysis_version);
      `);
    }
  },
  {
    version: 4,
    name: "004_editorial_metadata",
    up(db) {
      db.exec(`
        ALTER TABLE editions ADD COLUMN editorial_model_name TEXT NOT NULL DEFAULT 'legacy';
        ALTER TABLE editions ADD COLUMN editorial_prompt_version TEXT NOT NULL DEFAULT 'legacy';
        ALTER TABLE editions ADD COLUMN editorial_selection_method TEXT NOT NULL DEFAULT 'legacy';
      `);
    }
  }
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS.at(-1)?.version ?? 0;
