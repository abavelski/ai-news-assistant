import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { ConfigurationError } from "../errors.js";
import type { SourceConfig, SourceRunStatus } from "../sources/config.js";
import { NewsDatabase } from "./sqlite.js";

export interface SourceAttemptStatusInput {
  sourceId: string;
  sourceType: string;
  attemptedAt: string;
  succeeded: boolean;
  checkpoint?: string;
  discoveredCount: number;
  processedCount: number;
  failedCount: number;
  errorCode?: string;
  errorMessage?: string;
}

function parseSettings(value: unknown, sourceId: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("settings JSON is not an object");
    }
    return parsed as Record<string, unknown>;
  } catch (cause) {
    throw new ConfigurationError(`Persisted settings for source ${sourceId} are not valid JSON object data.`, { cause });
  }
}

function mapConfig(row: Record<string, unknown>): SourceConfig {
  return {
    id: String(row.id),
    type: String(row.type),
    enabled: Boolean(row.enabled),
    displayName: String(row.display_name),
    settingsVersion: Number(row.settings_version),
    settings: parseSettings(row.settings_json, String(row.id)),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function mapStatus(row: Record<string, unknown>): SourceRunStatus {
  return {
    sourceId: String(row.source_id),
    sourceType: String(row.source_type),
    lastAttemptAt: String(row.last_attempt_at),
    lastSuccessAt: row.last_success_at === null || row.last_success_at === undefined ? undefined : String(row.last_success_at),
    checkpoint: row.checkpoint === null || row.checkpoint === undefined ? undefined : String(row.checkpoint),
    discoveredCount: Number(row.discovered_count),
    processedCount: Number(row.processed_count),
    failedCount: Number(row.failed_count),
    errorCode: row.error_code === null || row.error_code === undefined ? undefined : String(row.error_code),
    errorMessage: row.error_message === null || row.error_message === undefined ? undefined : String(row.error_message)
  };
}

export class SourceConfigRepository {
  private readonly db: Database.Database;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    const migrator = new NewsDatabase(dataDir);
    migrator.close();
    this.db = new Database(path.join(dataDir, "news.sqlite"));
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("journal_mode = WAL");
  }

  close(): void {
    this.db.close();
  }

  list(): SourceConfig[] {
    const rows = this.db.prepare("SELECT * FROM source_configs ORDER BY id ASC").all() as Array<Record<string, unknown>>;
    return rows.map(mapConfig);
  }

  get(id: string): SourceConfig | undefined {
    const row = this.db.prepare("SELECT * FROM source_configs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? mapConfig(row) : undefined;
  }

  insert(config: SourceConfig): void {
    this.db.prepare(`
      INSERT INTO source_configs (
        id, type, enabled, display_name, settings_version, settings_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      config.id,
      config.type,
      config.enabled ? 1 : 0,
      config.displayName,
      config.settingsVersion,
      JSON.stringify(config.settings),
      config.createdAt,
      config.updatedAt
    );
  }

  update(config: SourceConfig): void {
    const result = this.db.prepare(`
      UPDATE source_configs SET
        enabled = ?,
        display_name = ?,
        settings_version = ?,
        settings_json = ?,
        updated_at = ?
      WHERE id = ? AND type = ?
    `).run(
      config.enabled ? 1 : 0,
      config.displayName,
      config.settingsVersion,
      JSON.stringify(config.settings),
      config.updatedAt,
      config.id,
      config.type
    );
    if (result.changes !== 1) {
      throw new ConfigurationError(`Source ${config.id} does not exist or its immutable type changed.`);
    }
  }

  getRunStatus(sourceId: string): SourceRunStatus | undefined {
    const row = this.db.prepare("SELECT * FROM source_run_status WHERE source_id = ?").get(sourceId) as
      | Record<string, unknown>
      | undefined;
    return row ? mapStatus(row) : undefined;
  }

  listRunStatuses(): SourceRunStatus[] {
    const rows = this.db.prepare("SELECT * FROM source_run_status ORDER BY source_id ASC").all() as Array<Record<string, unknown>>;
    return rows.map(mapStatus);
  }

  recordAttempt(input: SourceAttemptStatusInput): SourceRunStatus {
    this.db.prepare(`
      INSERT INTO source_run_status (
        source_id, source_type, last_attempt_at, last_success_at, checkpoint,
        discovered_count, processed_count, failed_count, error_code, error_message
      ) VALUES (
        @sourceId, @sourceType, @attemptedAt,
        CASE WHEN @succeeded = 1 THEN @attemptedAt ELSE NULL END,
        @checkpoint, @discoveredCount, @processedCount, @failedCount, @errorCode, @errorMessage
      )
      ON CONFLICT(source_id) DO UPDATE SET
        source_type = excluded.source_type,
        last_attempt_at = excluded.last_attempt_at,
        last_success_at = CASE
          WHEN @succeeded = 1 THEN excluded.last_attempt_at
          ELSE source_run_status.last_success_at
        END,
        checkpoint = COALESCE(excluded.checkpoint, source_run_status.checkpoint),
        discovered_count = excluded.discovered_count,
        processed_count = excluded.processed_count,
        failed_count = excluded.failed_count,
        error_code = excluded.error_code,
        error_message = excluded.error_message
    `).run({
      sourceId: input.sourceId,
      sourceType: input.sourceType,
      attemptedAt: input.attemptedAt,
      succeeded: input.succeeded ? 1 : 0,
      checkpoint: input.checkpoint ?? null,
      discoveredCount: input.discoveredCount,
      processedCount: input.processedCount,
      failedCount: input.failedCount,
      errorCode: input.errorCode ?? null,
      errorMessage: input.errorMessage ?? null
    });
    const status = this.getRunStatus(input.sourceId);
    if (!status) throw new Error(`Failed to persist source status for ${input.sourceId}.`);
    return status;
  }
}
