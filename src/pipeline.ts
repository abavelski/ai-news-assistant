import type { AppConfig } from "./config.js";
import { fetchAndExtract } from "./extraction/readability.js";
import { articleAnalysisPrompt, editorialPrompt } from "./llm/prompts.js";
import { parseJsonObject, type LlmProvider } from "./llm/provider.js";
import { renderEpub } from "./rendering/epub.js";
import type { NewsSource } from "./sources/source.js";
import { NewsDatabase } from "./storage/sqlite.js";
import type { ArticleAnalysis, EditionArticle, EditorialPlan, EditionResult } from "./types.js";

interface AnalysisJson {
  summary: string;
  topics: string[];
  importance: number;
  recommended: boolean;
  reason: string;
  keyFacts: string[];
}

interface EditorialJson {
  overview: string;
  selectedArticleIds: number[];
}

export async function runPipeline(config: AppConfig, source: NewsSource, llm: LlmProvider): Promise<EditionResult> {
  const db = new NewsDatabase(config.dataDir);
  const runStartedAt = new Date();
  const fallbackSince = new Date(runStartedAt.getTime() - config.lookbackHours * 60 * 60 * 1000);
  const lastRun = db.getSourceLastRun(source.id);
  const since = lastRun ? new Date(Math.max(new Date(lastRun).getTime(), fallbackSince.getTime())) : fallbackSince;

  console.log(`[pipeline] discovering ${source.id} items since ${since.toISOString()}`);
  const discovered = await source.discover(since);
  console.log(`[pipeline] discovered ${discovered.length} items`);

  const processed: EditionArticle[] = [];
  for (const item of discovered) {
    try {
      const extracted = await fetchAndExtract(item, config.editionLanguage);
      const { article, needsAnalysis } = db.upsertArticle(extracted);
      let analysis = db.getAnalysis(article.id);

      if (needsAnalysis || !analysis) {
        const raw = await llm.complete([
          { role: "system", content: "You are a careful news analyst. Return only JSON when requested." },
          { role: "user", content: articleAnalysisPrompt(article, config.editionLanguage) }
        ]);
        const parsed = parseJsonObject<AnalysisJson>(raw);
        analysis = {
          articleId: article.id,
          summary: parsed.summary,
          topics: Array.isArray(parsed.topics) ? parsed.topics : [],
          importance: Math.max(0, Math.min(100, Math.round(parsed.importance))),
          recommended: Boolean(parsed.recommended),
          reason: parsed.reason,
          keyFacts: Array.isArray(parsed.keyFacts) ? parsed.keyFacts : [],
          analyzedAt: new Date().toISOString()
        };
        db.saveAnalysis(analysis);
      }
      processed.push({ article, analysis });
    } catch (error) {
      console.error(`[pipeline] failed ${item.url}`, error);
    }
  }

  if (!processed.length) throw new Error("No articles were successfully processed; no edition generated.");

  const editorialRaw = await llm.complete([
    { role: "system", content: "You are a rigorous personal newspaper editor. Return only JSON when requested." },
    { role: "user", content: editorialPrompt(processed, config.editionLanguage, config.editionMaxArticles) }
  ]);

  let plan = parseJsonObject<EditorialJson>(editorialRaw) as EditorialPlan;
  const validIds = new Set(processed.map(({ article }) => article.id));
  plan.selectedArticleIds = plan.selectedArticleIds.filter((id) => validIds.has(id)).slice(0, config.editionMaxArticles);
  if (!plan.selectedArticleIds.length) {
    plan = {
      overview: plan.overview || "Morning edition",
      selectedArticleIds: [...processed]
        .sort((a, b) => b.analysis.importance - a.analysis.importance)
        .slice(0, config.editionMaxArticles)
        .map(({ article }) => article.id)
    };
  }

  const byId = new Map(processed.map((entry) => [entry.article.id, entry]));
  const selected = plan.selectedArticleIds.flatMap((id) => {
    const entry = byId.get(id);
    return entry ? [entry] : [];
  });
  const editionDate = new Date().toISOString().slice(0, 10);
  const rendered = await renderEpub(config, editionDate, plan, selected);
  db.saveEdition(editionDate, plan, rendered.epubPath);
  db.setSourceLastRun(source.id, runStartedAt.toISOString());

  return {
    editionDate,
    epubPath: rendered.epubPath,
    manifestPath: rendered.manifestPath,
    selectedCount: selected.length
  };
}
