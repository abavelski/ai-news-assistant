import path from "node:path";

export interface AppConfig {
  dataDir: string;
  outputDir: string;
  host: string;
  port: number;
  lookbackHours: number;
  maxArticles: number;
  editionMaxArticles: number;
  editionLanguage: string;
  includeFullArticles: boolean;
  meduzaRssUrl: string;
  llmBaseUrl: string;
  llmModel: string;
  llmApiKey?: string;
}

function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
}

function booleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

export function loadConfig(): AppConfig {
  const dataDir = path.resolve(process.env.DATA_DIR ?? "./data");
  return {
    dataDir,
    outputDir: path.resolve(process.env.OUTPUT_DIR ?? path.join(dataDir, "public", "daily")),
    host: process.env.HOST ?? "0.0.0.0",
    port: numberEnv("PORT", 8787),
    lookbackHours: numberEnv("LOOKBACK_HOURS", 24),
    maxArticles: numberEnv("MAX_ARTICLES", 50),
    editionMaxArticles: numberEnv("EDITION_MAX_ARTICLES", 10),
    editionLanguage: process.env.EDITION_LANGUAGE ?? "ru",
    includeFullArticles: booleanEnv("INCLUDE_FULL_ARTICLES", true),
    meduzaRssUrl: process.env.MEDUZA_RSS_URL ?? "https://meduza.io/rss/all",
    llmBaseUrl: (process.env.LLM_BASE_URL ?? "http://127.0.0.1:11434").replace(/\/$/, ""),
    llmModel: process.env.LLM_MODEL ?? "",
    llmApiKey: process.env.LLM_API_KEY || undefined
  };
}

export function assertPipelineConfig(config: AppConfig): void {
  if (!config.llmModel) {
    throw new Error("LLM_MODEL is required for the run command. Set it in the environment or .env loader of your choice.");
  }
}
