import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../config.js";
import { AppError } from "../errors.js";

export type RunAttemptStatus = "running" | "success" | "failed";

export interface RunStatus {
  version: 1;
  lastAttemptAt: string;
  lastAttemptStatus: RunAttemptStatus;
  lastSuccessfulRunAt?: string;
  lastSuccessfulEditionDate?: string;
  lastFailureAt?: string;
  lastFailureCode?: string;
}

export interface DeliveryHealthStatus {
  ok: true;
  server: "ok";
  degraded: boolean;
  latestEditionDate: string | null;
  latestEpubPresent: boolean;
  latestManifestPresent: boolean;
  latestManifestValid: boolean;
  lastSuccessfulRunAt: string | null;
  lastAttemptAt: string | null;
  lastAttemptStatus: RunAttemptStatus | null;
  lastFailureCode: string | null;
}

const STATUS_FILE = "run-status.json";
const EDITION_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isErrno(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

function validIso(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function parseRunStatus(raw: string): RunStatus | undefined {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value.version !== 1 || !validIso(value.lastAttemptAt)) return undefined;
    if (value.lastAttemptStatus !== "running" && value.lastAttemptStatus !== "success" && value.lastAttemptStatus !== "failed") {
      return undefined;
    }
    const result: RunStatus = {
      version: 1,
      lastAttemptAt: value.lastAttemptAt,
      lastAttemptStatus: value.lastAttemptStatus
    };
    if (validIso(value.lastSuccessfulRunAt)) result.lastSuccessfulRunAt = value.lastSuccessfulRunAt;
    if (typeof value.lastSuccessfulEditionDate === "string" && EDITION_PATTERN.test(value.lastSuccessfulEditionDate)) {
      result.lastSuccessfulEditionDate = value.lastSuccessfulEditionDate;
    }
    if (validIso(value.lastFailureAt)) result.lastFailureAt = value.lastFailureAt;
    if (typeof value.lastFailureCode === "string" && /^[A-Z0-9_:-]{1,64}$/.test(value.lastFailureCode)) {
      result.lastFailureCode = value.lastFailureCode;
    }
    return result;
  } catch {
    return undefined;
  }
}

export function runStatusPath(dataDir: string): string {
  return path.join(dataDir, STATUS_FILE);
}

export async function readRunStatus(dataDir: string): Promise<RunStatus | undefined> {
  try {
    return parseRunStatus(await fs.readFile(runStatusPath(dataDir), "utf8"));
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function writeRunStatus(dataDir: string, status: RunStatus): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true });
  const target = runStatusPath(dataDir);
  const temp = path.join(dataDir, `.${STATUS_FILE}.${process.pid}-${Date.now()}.tmp`);
  try {
    await fs.writeFile(temp, `${JSON.stringify(status, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temp, target);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function recordRunStarted(dataDir: string, now = new Date()): Promise<void> {
  const previous = await readRunStatus(dataDir);
  await writeRunStatus(dataDir, {
    version: 1,
    lastAttemptAt: now.toISOString(),
    lastAttemptStatus: "running",
    lastSuccessfulRunAt: previous?.lastSuccessfulRunAt,
    lastSuccessfulEditionDate: previous?.lastSuccessfulEditionDate,
    lastFailureAt: previous?.lastFailureAt,
    lastFailureCode: previous?.lastFailureCode
  });
}

export async function recordRunSucceeded(dataDir: string, editionDate: string, now = new Date()): Promise<void> {
  const previous = await readRunStatus(dataDir);
  await writeRunStatus(dataDir, {
    version: 1,
    lastAttemptAt: now.toISOString(),
    lastAttemptStatus: "success",
    lastSuccessfulRunAt: now.toISOString(),
    lastSuccessfulEditionDate: EDITION_PATTERN.test(editionDate) ? editionDate : previous?.lastSuccessfulEditionDate,
    lastFailureAt: previous?.lastFailureAt,
    lastFailureCode: previous?.lastFailureCode
  });
}

function safeFailureCode(error: unknown): string {
  if (error instanceof AppError) return error.code;
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    const code = error.code.toUpperCase();
    if (/^[A-Z0-9_:-]{1,64}$/.test(code)) return code;
  }
  return "UNEXPECTED_ERROR";
}

export async function recordRunFailed(dataDir: string, error: unknown, now = new Date()): Promise<void> {
  const previous = await readRunStatus(dataDir);
  await writeRunStatus(dataDir, {
    version: 1,
    lastAttemptAt: now.toISOString(),
    lastAttemptStatus: "failed",
    lastSuccessfulRunAt: previous?.lastSuccessfulRunAt,
    lastSuccessfulEditionDate: previous?.lastSuccessfulEditionDate,
    lastFailureAt: now.toISOString(),
    lastFailureCode: safeFailureCode(error)
  });
}

async function filePresent(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
}

async function readManifest(outputDir: string): Promise<{ present: boolean; valid: boolean; editionDate?: string }> {
  const manifestPath = path.join(outputDir, "latest.json");
  if (!await filePresent(manifestPath)) return { present: false, valid: false };
  try {
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as Record<string, unknown>;
    const editionDate = typeof manifest.edition === "string" && EDITION_PATTERN.test(manifest.edition)
      ? manifest.edition
      : undefined;
    return { present: true, valid: Boolean(editionDate), editionDate };
  } catch {
    return { present: true, valid: false };
  }
}

export async function buildDeliveryHealth(config: AppConfig): Promise<DeliveryHealthStatus> {
  const [epubPresent, manifest, runStatus] = await Promise.all([
    filePresent(path.join(config.outputDir, "latest.epub")),
    readManifest(config.outputDir),
    readRunStatus(config.dataDir)
  ]);

  const mismatchedFiles = epubPresent !== manifest.present;
  const degraded = runStatus?.lastAttemptStatus === "failed"
    || mismatchedFiles
    || (manifest.present && !manifest.valid);

  return {
    ok: true,
    server: "ok",
    degraded,
    latestEditionDate: manifest.editionDate ?? runStatus?.lastSuccessfulEditionDate ?? null,
    latestEpubPresent: epubPresent,
    latestManifestPresent: manifest.present,
    latestManifestValid: manifest.valid,
    lastSuccessfulRunAt: runStatus?.lastSuccessfulRunAt ?? null,
    lastAttemptAt: runStatus?.lastAttemptAt ?? null,
    lastAttemptStatus: runStatus?.lastAttemptStatus ?? null,
    lastFailureCode: runStatus?.lastFailureCode ?? null
  };
}
