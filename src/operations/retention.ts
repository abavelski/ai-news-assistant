import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../config.js";

export interface RetentionResult {
  deletedEditions: number;
  deletedBuildDirectories: number;
}

const DATE_PATTERN = /^(\d{4}-\d{2}-\d{2})$/;
const EPUB_PATTERN = /^(\d{4}-\d{2}-\d{2})\.epub$/;

function cutoffDate(reference: Date, retentionDays: number): string {
  const day = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), reference.getUTCDate()));
  day.setUTCDate(day.getUTCDate() - (retentionDays - 1));
  return day.toISOString().slice(0, 10);
}

async function listDirectory(directory: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

export async function pruneRetention(config: AppConfig, reference = new Date()): Promise<RetentionResult> {
  const editionCutoff = cutoffDate(reference, config.editionRetentionDays);
  const buildCutoff = cutoffDate(reference, config.buildRetentionDays);
  let deletedEditions = 0;
  let deletedBuildDirectories = 0;

  for (const entry of await listDirectory(config.outputDir)) {
    if (!entry.isFile()) continue;
    const match = EPUB_PATTERN.exec(entry.name);
    if (!match?.[1] || match[1] >= editionCutoff) continue;
    await fs.rm(path.join(config.outputDir, entry.name));
    deletedEditions += 1;
  }

  const buildsDir = path.join(config.dataDir, "builds");
  for (const entry of await listDirectory(buildsDir)) {
    if (!entry.isDirectory()) continue;
    const match = DATE_PATTERN.exec(entry.name);
    if (!match?.[1] || match[1] >= buildCutoff) continue;
    await fs.rm(path.join(buildsDir, entry.name), { recursive: true, force: true });
    deletedBuildDirectories += 1;
  }

  return { deletedEditions, deletedBuildDirectories };
}
