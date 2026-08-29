import type { AppConfig } from "./config.js";
import { ExtractionError, FetchError, LlmError } from "./errors.js";
import { fetchAndExtract } from "./extraction/readability.js";
import { sleep } from "./http.js";
import { analyzeArticle, articleAnalysisIdentity } from "./llm/article-analysis.js";
import { selectEditorialPlan } from "./llm/editorial.js";
import type { LlmProvider } from "./llm/provider.js";
import { logger } from "./logging.js";
import { renderEpub } from "./rendering/epub.js";
import type { NewsSource } from "./sources/source.js";
import { NewsDatabase } from "./storage/sqlite.js";
import type { EditionArticle, EditionResult } from "./types.js";

export async function runPipeline(config: AppConfig, source: NewsSource, llm: LlmProvider): Promise<EditionResult> {
  const log = logger.child({ component: "pipeline", sourceId: source.id });
  const db = new NewsDatabase(config.dataDir);
  const runStartedAt = new Date();
  const fallbackSince = new Date(runStartedAt.getTime() - config.lookbackHours * 60 * 60 * 1000);
  const lastRun = db.getSourceCheckpoint(source.id);
  const since = lastRun ? new Date(Math.max(new Date(lastRun).getTime(), fallbackSince.getTime())) : fallbackSince;
  const analysisIdentity = articleAnalysisIdentity(config.llmModel);

  log.info("discovering source items", { since: since.toISOString() });
  const discovered = await source.discover(since);
  log.info("source discovery completed", { discoveredCount: discovered.length });

  const processed: EditionArticle[] = [];
  let failedCount = 0;
  const failedPublishedAt: string[] = [];
  for (let index = 0; index < discovered.length; index += 1) {
    const item = discovered[index];
    if (!item) continue;
    if (index > 0) await sleep(config.articleFetchDelayMs);

    try {
      const extracted = await fetchAndExtract(item, {
        language: config.editionLanguage,
        userAgent: config.httpUserAgent,
        timeoutMs: config.httpTimeoutMs,
        retries: config.httpRetries,
        retryBaseDelayMs: config.httpRetryBaseDelayMs,
        minArticleChars: config.minArticleChars
      });
      const { article } = db.upsertArticle(extracted);
      let analysis = db.getAnalysis(article.id, analysisIdentity);

      if (!analysis) {
        analysis = await analyzeArticle(article, llm, {
          language: config.editionLanguage,
          modelName: config.llmModel,
          maxArticleChars: config.llmArticleMaxChars,
          retries: config.llmRetries,
          retryBaseDelayMs: config.llmRetryBaseDelayMs
        });
        db.saveAnalysis(analysis);
        log.info("article analysis completed", {
          articleId: article.id,
          modelName: analysis.modelName,
          promptVersion: analysis.promptVersion,
          analysisVersion: analysis.analysisVersion,
          latencyMs: analysis.latencyMs,
          promptTokens: analysis.promptTokens,
          completionTokens: analysis.completionTokens,
          totalTokens: analysis.totalTokens
        });
      } else {
        log.debug("article analysis cache hit", { articleId: article.id, ...analysisIdentity });
      }
      processed.push({ article, analysis });
    } catch (error) {
      failedCount += 1;
      failedPublishedAt.push(item.publishedAt);
      const stage = error instanceof FetchError
        ? "fetch"
        : error instanceof ExtractionError
          ? "extraction"
          : error instanceof LlmError
            ? "llm"
            : "processing";
      log.warn("article processing failed", { url: item.url, stage, error });
    }
  }

  log.info("article processing completed", { processedCount: processed.length, failedCount });

  if (!processed.length) {
    throw new ExtractionError("No articles were successfully processed; no edition was generated.", {
      context: { sourceId: source.id, discoveredCount: discovered.length }
    });
  }

  const editorial = await selectEditorialPlan(processed, llm, {
    language: config.editionLanguage,
    modelName: config.llmModel,
    maxArticles: config.editionMaxArticles,
    maxPerTopic: config.editorialMaxPerTopic
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
  const rendered = await renderEpub(config, editionDate, plan, selected);
  db.saveEdition(editionDate, plan, rendered.epubPath, editorial.metadata);
  const checkpoint = db.recordSourceRunCompletion(
    source.id,
    runStartedAt.toISOString(),
    failedPublishedAt
  );
  log.info("source checkpoint recorded", {
    checkpoint,
    partial: failedPublishedAt.length > 0,
    failedCount: failedPublishedAt.length
  });

  return {
    editionDate,
    epubPath: rendered.epubPath,
    manifestPath: rendered.manifestPath,
    selectedCount: selected.length
  };
}
