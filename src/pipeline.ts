import type { AppConfig } from "./config.js";
import { AppError, ExtractionError, FetchError, LlmError } from "./errors.js";
import { sleep } from "./http.js";
import { analyzeContent, contentAnalysisIdentity } from "./llm/article-analysis.js";
import { selectEditorialPlan } from "./llm/editorial.js";
import type { LlmProvider } from "./llm/provider.js";
import { logger } from "./logging.js";
import { PandocEpubRenderer } from "./rendering/epub.js";
import type { EditionRenderer } from "./rendering/renderer.js";
import {
  validateDiscoveredItem,
  validateMaterializedContent,
  type SourceAdapter
} from "./sources/source.js";
import { SourceConfigRepository } from "./storage/source-config.js";
import { NewsDatabase } from "./storage/sqlite.js";
import type { EditionArticle, EditionResult } from "./types.js";

function sanitizeStatusMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : "Source discovery failed.";
  const sanitizedUrls = raw.replace(/https?:\/\/[^\s)\]}>,]+/gi, (value) => {
    try {
      const url = new URL(value);
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      return url.toString();
    } catch {
      return "[url]";
    }
  });
  return sanitizedUrls
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(api[_-]?key|token|secret|password)\s*[=:]\s*[^\s,;]+/gi, "$1=[redacted]")
    .slice(0, 500);
}

function statusErrorCode(error: unknown): string {
  return error instanceof AppError ? error.code : "SOURCE_DISCOVERY_ERROR";
}

function sourceStage(error: unknown): "fetch" | "extraction" | "llm" | "processing" {
  if (error instanceof FetchError) return "fetch";
  if (error instanceof ExtractionError) return "extraction";
  if (error instanceof LlmError) return "llm";
  return "processing";
}

function normalizeSources(sources: SourceAdapter | SourceAdapter[]): SourceAdapter[] {
  const normalized = (Array.isArray(sources) ? [...sources] : [sources])
    .sort((left, right) => left.id.localeCompare(right.id));
  if (normalized.length === 0) {
    throw new ExtractionError("No enabled sources were supplied to the pipeline.");
  }
  const seen = new Set<string>();
  for (const source of normalized) {
    if (seen.has(source.id)) {
      throw new ExtractionError(`Duplicate source adapter id ${source.id}.`, { context: { sourceId: source.id } });
    }
    seen.add(source.id);
  }
  return normalized;
}

export async function runPipeline(
  config: AppConfig,
  sources: SourceAdapter | SourceAdapter[],
  llm: LlmProvider,
  renderer: EditionRenderer = new PandocEpubRenderer()
): Promise<EditionResult> {
  const adapters = normalizeSources(sources);
  const log = logger.child({ component: "pipeline", sourceCount: adapters.length });
  const db = new NewsDatabase(config.dataDir);
  const sourceRepository = new SourceConfigRepository(config.dataDir);
  const analysisIdentity = contentAnalysisIdentity(config.llmModel);
  const processed: EditionArticle[] = [];

  try {
    for (const source of adapters) {
      const sourceLog = logger.child({ component: "pipeline-source", sourceId: source.id, sourceType: source.type });
      const sourceStartedAt = new Date();
      const fallbackSince = new Date(sourceStartedAt.getTime() - config.lookbackHours * 60 * 60 * 1000);
      const lastRun = db.getSourceCheckpoint(source.id);
      const since = lastRun
        ? new Date(Math.max(new Date(lastRun).getTime(), fallbackSince.getTime()))
        : fallbackSince;

      let discovered;
      try {
        sourceLog.info("discovering source items", { since: since.toISOString() });
        discovered = (await source.discover(since)).map((item) => validateDiscoveredItem(item, source));
        sourceLog.info("source discovery completed", { discoveredCount: discovered.length });
      } catch (error) {
        sourceLog.warn("source discovery failed", { error });
        sourceRepository.recordAttempt({
          sourceId: source.id,
          sourceType: source.type,
          attemptedAt: sourceStartedAt.toISOString(),
          succeeded: false,
          checkpoint: db.getSourceCheckpoint(source.id),
          discoveredCount: 0,
          processedCount: 0,
          failedCount: 0,
          errorCode: statusErrorCode(error),
          errorMessage: sanitizeStatusMessage(error)
        });
        continue;
      }

      const sourceProcessed: EditionArticle[] = [];
      const failedPublishedAt: string[] = [];
      let failedCount = 0;

      for (let index = 0; index < discovered.length; index += 1) {
        const item = discovered[index];
        if (!item) continue;
        if (index > 0) await sleep(config.articleFetchDelayMs);

        try {
          const materialized = validateMaterializedContent(await source.materialize(item), item, source);
          const { article } = db.upsertArticle(materialized);
          let analysis = db.getAnalysis(article.id, analysisIdentity);

          if (!analysis) {
            analysis = await analyzeContent(article, llm, {
              language: config.editionLanguage,
              modelName: config.llmModel,
              maxArticleChars: config.llmArticleMaxChars,
              retries: config.llmRetries,
              retryBaseDelayMs: config.llmRetryBaseDelayMs
            });
            db.saveAnalysis(analysis);
            sourceLog.info("content analysis completed", {
              articleId: article.id,
              contentKind: article.contentKind,
              modelName: analysis.modelName,
              promptVersion: analysis.promptVersion,
              analysisVersion: analysis.analysisVersion,
              latencyMs: analysis.latencyMs,
              promptTokens: analysis.promptTokens,
              completionTokens: analysis.completionTokens,
              totalTokens: analysis.totalTokens
            });
          } else {
            sourceLog.debug("content analysis cache hit", { articleId: article.id, ...analysisIdentity });
          }
          sourceProcessed.push({ article, analysis });
        } catch (error) {
          failedCount += 1;
          failedPublishedAt.push(item.publishedAt);
          sourceLog.warn("source item processing failed", {
            externalId: item.externalId,
            url: item.url,
            contentKind: item.contentKind,
            stage: sourceStage(error),
            error
          });
        }
      }

      processed.push(...sourceProcessed);
      const checkpoint = db.recordSourceRunCompletion(
        source.id,
        sourceStartedAt.toISOString(),
        failedPublishedAt
      );
      sourceRepository.recordAttempt({
        sourceId: source.id,
        sourceType: source.type,
        attemptedAt: sourceStartedAt.toISOString(),
        succeeded: true,
        checkpoint,
        discoveredCount: discovered.length,
        processedCount: sourceProcessed.length,
        failedCount
      });
      sourceLog.info("source processing completed", {
        discoveredCount: discovered.length,
        processedCount: sourceProcessed.length,
        failedCount,
        checkpoint,
        partial: failedCount > 0
      });
    }

    if (!processed.length) {
      throw new ExtractionError("No enabled source produced successfully processed content; no edition was generated.", {
        context: { sourceIds: adapters.map((source) => source.id) }
      });
    }

    const editorial = await selectEditorialPlan(processed, llm, {
      language: config.editionLanguage,
      modelName: config.llmModel,
      maxArticles: config.editionMaxArticles,
      maxPerTopic: config.editorialMaxPerTopic,
      maxPerSource: config.editorialMaxPerSource
    });
    const plan = editorial.plan;
    log.info("editorial selection completed", {
      selectedCount: plan.selectedArticleIds.length,
      modelName: editorial.metadata.modelName,
      promptVersion: editorial.metadata.promptVersion,
      selectionMethod: editorial.metadata.selectionMethod
    });

    const byId = new Map(processed.map((entry) => [entry.article.id, entry]));
    const selected = plan.selectedArticleIds.flatMap((id) => {
      const entry = byId.get(id);
      return entry ? [entry] : [];
    });
    const editionDate = new Date().toISOString().slice(0, 10);
    const rendered = await renderer.render({ config, editionDate, plan, selected });
    db.saveEdition(editionDate, plan, rendered.epubPath, editorial.metadata);

    return {
      editionDate,
      epubPath: rendered.epubPath,
      manifestPath: rendered.manifestPath,
      selectedCount: selected.length
    };
  } finally {
    sourceRepository.close();
    db.close();
  }
}
