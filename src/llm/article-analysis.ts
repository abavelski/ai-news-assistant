import { LlmError } from "../errors.js";
import { retryDelayMs, sleep as defaultSleep, type SleepFunction } from "../http.js";
import { logger } from "../logging.js";
import type { AnalysisIdentity, Article, ArticleAnalysis } from "../types.js";
import { contentAnalysisPrompt, CONTENT_ANALYSIS_PROMPT_VERSION } from "./prompts.js";
import { isRetryableLlmError, parseJsonObject, type LlmProvider, type LlmUsage } from "./provider.js";

export const CONTENT_ANALYSIS_VERSION = "content-analysis-schema-v2";
export const ARTICLE_ANALYSIS_VERSION = CONTENT_ANALYSIS_VERSION;

interface ContentAnalysisPayload {
  summary: string;
  topics: string[];
  importance: number;
  recommended: boolean;
  reason: string;
  keyPoints: string[];
}

export interface AnalyzeContentOptions {
  language: string;
  modelName: string;
  maxArticleChars: number;
  retries: number;
  retryBaseDelayMs: number;
  sleep?: SleepFunction;
}

export type AnalyzeArticleOptions = AnalyzeContentOptions;

const EXPECTED_FIELDS = new Set(["summary", "topics", "importance", "recommended", "reason", "keyPoints"]);

function stringField(value: unknown, name: string, maxLength: number, issues: string[]): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    issues.push(`${name} must be a non-empty string`);
    return undefined;
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) issues.push(`${name} exceeds ${maxLength} characters`);
  return normalized;
}

function stringArrayField(
  value: unknown,
  name: string,
  maxItems: number,
  maxItemLength: number,
  issues: string[]
): string[] | undefined {
  if (!Array.isArray(value)) {
    issues.push(`${name} must be an array`);
    return undefined;
  }
  if (value.length > maxItems) issues.push(`${name} must contain at most ${maxItems} items`);
  const result: string[] = [];
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string" || !entry.trim()) {
      issues.push(`${name}[${index}] must be a non-empty string`);
      continue;
    }
    const normalized = entry.trim();
    if (normalized.length > maxItemLength) issues.push(`${name}[${index}] exceeds ${maxItemLength} characters`);
    result.push(normalized);
  }
  return result;
}

export function validateContentAnalysis(value: unknown): ContentAnalysisPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LlmError("Content analysis output must be a JSON object.", {
      context: { retryable: true, kind: "invalid-output" }
    });
  }

  const record = value as Record<string, unknown>;
  const issues: string[] = [];
  for (const key of Object.keys(record)) {
    if (!EXPECTED_FIELDS.has(key)) issues.push(`unexpected field ${key}`);
  }

  const summary = stringField(record.summary, "summary", 12_000, issues);
  const topics = stringArrayField(record.topics, "topics", 20, 200, issues);
  const reason = stringField(record.reason, "reason", 8_000, issues);
  const keyPoints = stringArrayField(record.keyPoints, "keyPoints", 30, 1_000, issues);

  if (!Number.isInteger(record.importance) || Number(record.importance) < 0 || Number(record.importance) > 100) {
    issues.push("importance must be an integer from 0 to 100");
  }
  if (typeof record.recommended !== "boolean") issues.push("recommended must be a boolean");

  if (issues.length > 0 || !summary || !topics || !reason || !keyPoints) {
    throw new LlmError("Content analysis output failed schema validation.", {
      context: { retryable: true, kind: "invalid-output", issues }
    });
  }

  return {
    summary,
    topics,
    importance: Number(record.importance),
    recommended: record.recommended as boolean,
    reason,
    keyPoints
  };
}

export const validateArticleAnalysis = validateContentAnalysis;

export function parseContentAnalysis(raw: string): ContentAnalysisPayload {
  return validateContentAnalysis(parseJsonObject<Record<string, unknown>>(raw));
}

export const parseArticleAnalysis = parseContentAnalysis;

export function contentAnalysisIdentity(modelName: string): AnalysisIdentity {
  return {
    modelName,
    promptVersion: CONTENT_ANALYSIS_PROMPT_VERSION,
    analysisVersion: CONTENT_ANALYSIS_VERSION
  };
}

export const articleAnalysisIdentity = contentAnalysisIdentity;

function addUsage(total: LlmUsage, usage: LlmUsage | undefined): void {
  if (!usage) return;
  if (usage.promptTokens !== undefined) total.promptTokens = (total.promptTokens ?? 0) + usage.promptTokens;
  if (usage.completionTokens !== undefined) total.completionTokens = (total.completionTokens ?? 0) + usage.completionTokens;
  if (usage.totalTokens !== undefined) total.totalTokens = (total.totalTokens ?? 0) + usage.totalTokens;
}

export async function analyzeContent(
  article: Article & { id: number },
  provider: LlmProvider,
  options: AnalyzeContentOptions
): Promise<ArticleAnalysis> {
  const identity = contentAnalysisIdentity(options.modelName);
  const log = logger.child({ component: "content-analysis", articleId: article.id, contentKind: article.contentKind, ...identity });
  const sleep = options.sleep ?? defaultSleep;
  const totalAttempts = options.retries + 1;
  const usage: LlmUsage = {};
  let latencyMs = 0;

  const messages = [
    { role: "system" as const, content: "You are a careful content analyst. Return only JSON when requested." },
    { role: "user" as const, content: contentAnalysisPrompt(article, options.language, options.maxArticleChars) }
  ];

  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    try {
      const completion = await provider.complete(messages);
      latencyMs += completion.latencyMs;
      addUsage(usage, completion.usage);
      const parsed = parseContentAnalysis(completion.content);

      return {
        articleId: article.id,
        ...identity,
        ...parsed,
        analyzedAt: new Date().toISOString(),
        latencyMs,
        ...usage
      };
    } catch (error) {
      if (error instanceof LlmError && typeof error.context?.latencyMs === "number") {
        latencyMs += Math.max(0, Math.round(error.context.latencyMs));
      }
      const retryable = isRetryableLlmError(error);
      if (!retryable || attempt === totalAttempts) throw error;

      const delayMs = retryDelayMs(options.retryBaseDelayMs, attempt);
      log.warn("retrying content analysis", { attempt, nextAttempt: attempt + 1, delayMs, error });
      await sleep(delayMs);
    }
  }

  throw new LlmError("Content analysis failed after all attempts.", {
    context: { retryable: false, articleId: article.id }
  });
}

export const analyzeArticle = analyzeContent;
