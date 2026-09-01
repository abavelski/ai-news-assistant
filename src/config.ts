import path from "node:path";
import { loadEnvFile } from "node:process";
import { ConfigurationError } from "./errors.js";
import { isLogLevel, type LogLevel } from "./logging.js";

export interface AppConfig {
  dataDir: string;
  outputDir: string;
  host: string;
  port: number;
  lookbackHours: number;
  maxArticles: number;
  editionMaxArticles: number;
  editorialMaxPerTopic: number;
  editorialMaxPerSource: number;
  editorialMaxDiscussions: number;
  editionLanguage: string;
  includeFullArticles: boolean;
  editionRetentionDays: number;
  buildRetentionDays: number;
  meduzaRssUrl: string;
  redditClientId?: string;
  redditClientSecret?: string;
  redditUserAgent: string;
  redditHttpTimeoutMs: number;
  redditHttpRetries: number;
  redditRetryBaseDelayMs: number;
  redditMaxResponseBytes: number;
  redditMaxRateLimitWaitMs: number;
  redditMaxTotalCandidates: number;
  redditLlmTrustBoundary: "local" | "external-acknowledged";
  httpUserAgent: string;
  httpTimeoutMs: number;
  httpRetries: number;
  httpRetryBaseDelayMs: number;
  articleFetchDelayMs: number;
  minArticleChars: number;
  llmBaseUrl: string;
  llmModel: string;
  llmApiKey?: string;
  llmTemperature: number;
  llmMaxOutputTokens: number;
  llmTimeoutMs: number;
  llmRetries: number;
  llmRetryBaseDelayMs: number;
  llmArticleMaxChars: number;
  logLevel: LogLevel;
}

type Environment = Record<string, string | undefined>;

function readOptional(env: Environment, name: string): string | undefined {
  const value = env[name];
  return value === undefined ? undefined : value.trim();
}

function nonEmptyEnv(env: Environment, name: string, fallback: string): string {
  const raw = readOptional(env, name);
  if (raw === undefined) return fallback;
  if (!raw) throw new ConfigurationError(`${name} must not be empty.`);
  return raw;
}

function integerEnv(env: Environment, name: string, fallback: number, min: number, max: number): number {
  const raw = readOptional(env, name);
  if (raw === undefined) return fallback;
  if (!/^[-+]?\d+$/.test(raw)) {
    throw new ConfigurationError(`${name} must be an integer between ${min} and ${max}; received ${JSON.stringify(raw)}.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ConfigurationError(`${name} must be an integer between ${min} and ${max}; received ${JSON.stringify(raw)}.`);
  }
  return value;
}

function numberEnv(env: Environment, name: string, fallback: number, min: number, max: number): number {
  const raw = readOptional(env, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new ConfigurationError(`${name} must be a number between ${min} and ${max}; received ${JSON.stringify(raw)}.`);
  }
  return value;
}

function booleanEnv(env: Environment, name: string, fallback: boolean): boolean {
  const raw = readOptional(env, name);
  if (raw === undefined) return fallback;
  const normalized = raw.toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new ConfigurationError(`${name} must be one of true/false, 1/0, yes/no, or on/off; received ${JSON.stringify(raw)}.`);
}

function redditTrustBoundaryEnv(env: Environment): "local" | "external-acknowledged" {
  const value = readOptional(env, "REDDIT_LLM_TRUST_BOUNDARY") ?? "local";
  if (value !== "local" && value !== "external-acknowledged") {
    throw new ConfigurationError(
      `REDDIT_LLM_TRUST_BOUNDARY must be local or external-acknowledged; received ${JSON.stringify(value)}.`
    );
  }
  return value;
}

function httpUrlEnv(env: Environment, name: string, fallback: string): string {
  const raw = nonEmptyEnv(env, name, fallback);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch (cause) {
    throw new ConfigurationError(`${name} must be a valid http(s) URL; received ${JSON.stringify(raw)}.`, { cause });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ConfigurationError(`${name} must use http:// or https://; received ${JSON.stringify(raw)}.`);
  }
  return raw.replace(/\/+$/, "");
}

function logLevelEnv(env: Environment): LogLevel {
  const raw = readOptional(env, "LOG_LEVEL") ?? "info";
  if (!isLogLevel(raw)) {
    throw new ConfigurationError(`LOG_LEVEL must be one of debug, info, warn, or error; received ${JSON.stringify(raw)}.`);
  }
  return raw;
}

export function loadLocalEnv(envFile = path.resolve(".env")): boolean {
  try {
    loadEnvFile(envFile);
    return true;
  } catch (cause) {
    if (cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT") return false;
    throw new ConfigurationError(`Could not load environment file ${envFile}.`, {
      cause,
      context: { envFile }
    });
  }
}

export function parseConfig(env: Environment = process.env): AppConfig {
  const dataDirRaw = nonEmptyEnv(env, "DATA_DIR", "./data");
  const dataDir = path.resolve(dataDirRaw);
  const outputDirRaw = nonEmptyEnv(env, "OUTPUT_DIR", path.join(dataDir, "public", "daily"));
  const maxArticles = integerEnv(env, "MAX_ARTICLES", 50, 1, 1000);
  const editionMaxArticles = integerEnv(env, "EDITION_MAX_ARTICLES", 10, 1, 1000);
  const editorialMaxPerTopic = integerEnv(env, "EDITORIAL_MAX_PER_TOPIC", Math.min(3, editionMaxArticles), 1, 1000);
  const editorialMaxPerSource = integerEnv(env, "EDITORIAL_MAX_PER_SOURCE", editionMaxArticles, 1, 1000);
  const editorialMaxDiscussions = integerEnv(env, "EDITORIAL_MAX_DISCUSSIONS", Math.min(3, editionMaxArticles), 0, 1000);

  if (editionMaxArticles > maxArticles) {
    throw new ConfigurationError(
      `EDITION_MAX_ARTICLES (${editionMaxArticles}) must not exceed MAX_ARTICLES (${maxArticles}).`
    );
  }
  if (editorialMaxPerTopic > editionMaxArticles) {
    throw new ConfigurationError(
      `EDITORIAL_MAX_PER_TOPIC (${editorialMaxPerTopic}) must not exceed EDITION_MAX_ARTICLES (${editionMaxArticles}).`
    );
  }
  if (editorialMaxPerSource > editionMaxArticles) {
    throw new ConfigurationError(
      `EDITORIAL_MAX_PER_SOURCE (${editorialMaxPerSource}) must not exceed EDITION_MAX_ARTICLES (${editionMaxArticles}).`
    );
  }
  if (editorialMaxDiscussions > editionMaxArticles) {
    throw new ConfigurationError(
      `EDITORIAL_MAX_DISCUSSIONS (${editorialMaxDiscussions}) must not exceed EDITION_MAX_ARTICLES (${editionMaxArticles}).`
    );
  }

  return {
    dataDir,
    outputDir: path.resolve(outputDirRaw),
    host: nonEmptyEnv(env, "HOST", "0.0.0.0"),
    port: integerEnv(env, "PORT", 8787, 1, 65535),
    lookbackHours: integerEnv(env, "LOOKBACK_HOURS", 24, 1, 720),
    maxArticles,
    editionMaxArticles,
    editorialMaxPerTopic,
    editorialMaxPerSource,
    editorialMaxDiscussions,
    editionLanguage: nonEmptyEnv(env, "EDITION_LANGUAGE", "ru"),
    includeFullArticles: booleanEnv(env, "INCLUDE_FULL_ARTICLES", true),
    editionRetentionDays: integerEnv(env, "EDITION_RETENTION_DAYS", 30, 1, 3650),
    buildRetentionDays: integerEnv(env, "BUILD_RETENTION_DAYS", 7, 1, 3650),
    meduzaRssUrl: httpUrlEnv(env, "MEDUZA_RSS_URL", "https://meduza.io/rss/all"),
    redditClientId: readOptional(env, "REDDIT_CLIENT_ID") || undefined,
    redditClientSecret: readOptional(env, "REDDIT_CLIENT_SECRET") || undefined,
    redditUserAgent: readOptional(env, "REDDIT_USER_AGENT") ?? "",
    redditHttpTimeoutMs: integerEnv(env, "REDDIT_HTTP_TIMEOUT_MS", 20_000, 1_000, 120_000),
    redditHttpRetries: integerEnv(env, "REDDIT_HTTP_RETRIES", 2, 0, 10),
    redditRetryBaseDelayMs: integerEnv(env, "REDDIT_RETRY_BASE_DELAY_MS", 500, 0, 30_000),
    redditMaxResponseBytes: integerEnv(env, "REDDIT_MAX_RESPONSE_BYTES", 2_000_000, 10_000, 20_000_000),
    redditMaxRateLimitWaitMs: integerEnv(env, "REDDIT_MAX_RATE_LIMIT_WAIT_MS", 60_000, 0, 600_000),
    redditMaxTotalCandidates: integerEnv(env, "REDDIT_MAX_TOTAL_CANDIDATES", 20, 1, 200),
    redditLlmTrustBoundary: redditTrustBoundaryEnv(env),
    httpUserAgent: nonEmptyEnv(env, "HTTP_USER_AGENT", "ai-news-assistant/0.1 (+personal self-hosted reader)"),
    httpTimeoutMs: integerEnv(env, "HTTP_TIMEOUT_MS", 20_000, 1_000, 120_000),
    httpRetries: integerEnv(env, "HTTP_RETRIES", 2, 0, 10),
    httpRetryBaseDelayMs: integerEnv(env, "HTTP_RETRY_BASE_DELAY_MS", 500, 0, 30_000),
    articleFetchDelayMs: integerEnv(env, "ARTICLE_FETCH_DELAY_MS", 250, 0, 10_000),
    minArticleChars: integerEnv(env, "MIN_ARTICLE_CHARS", 200, 100, 10_000),
    llmBaseUrl: httpUrlEnv(env, "LLM_BASE_URL", "http://127.0.0.1:11434"),
    llmModel: readOptional(env, "LLM_MODEL") ?? "",
    llmApiKey: readOptional(env, "LLM_API_KEY") || undefined,
    llmTemperature: numberEnv(env, "LLM_TEMPERATURE", 0.2, 0, 2),
    llmMaxOutputTokens: integerEnv(env, "LLM_MAX_OUTPUT_TOKENS", 1_200, 64, 32_768),
    llmTimeoutMs: integerEnv(env, "LLM_TIMEOUT_MS", 120_000, 1_000, 600_000),
    llmRetries: integerEnv(env, "LLM_RETRIES", 2, 0, 5),
    llmRetryBaseDelayMs: integerEnv(env, "LLM_RETRY_BASE_DELAY_MS", 500, 0, 30_000),
    llmArticleMaxChars: integerEnv(env, "LLM_ARTICLE_MAX_CHARS", 28_000, 1_000, 100_000),
    logLevel: logLevelEnv(env)
  };
}

export function loadConfig(): AppConfig {
  return parseConfig(process.env);
}

export function assertPipelineConfig(config: AppConfig): void {
  if (!config.llmModel) {
    throw new ConfigurationError(
      "LLM_MODEL is required for the run command. Set it in .env for local development or in the service environment under systemd."
    );
  }
}
