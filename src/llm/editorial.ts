import { LlmError } from "../errors.js";
import { logger } from "../logging.js";
import type { EditionArticle, EditorialMetadata, EditorialPlan } from "../types.js";
import { editorialPrompt, EDITORIAL_PROMPT_VERSION } from "./prompts.js";
import { parseJsonObject, type LlmProvider } from "./provider.js";

export interface EditorialSelectionOptions {
  language: string;
  modelName: string;
  maxArticles: number;
  maxPerTopic: number;
}

const EXPECTED_FIELDS = new Set(["overview", "selectedArticleIds"]);

function primaryTopic(item: EditionArticle): string | undefined {
  const topic = item.analysis.topics.find((value) => value.trim().length > 0)?.trim().toLocaleLowerCase("und");
  return topic || undefined;
}

function wordSet(value: string): Set<string> {
  const words = value
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .match(/[\p{L}\p{N}]+/gu) ?? [];
  return new Set(words.filter((word) => word.length >= 3));
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection += 1;
  const union = left.size + right.size - intersection;
  return union > 0 ? intersection / union : 0;
}

export function areNearDuplicateStories(left: EditionArticle, right: EditionArticle): boolean {
  if (left.article.sourceId !== right.article.sourceId) return false;

  const leftTitle = wordSet(left.article.title);
  const rightTitle = wordSet(right.article.title);
  if (jaccard(leftTitle, rightTitle) >= 0.72) return true;

  const leftSummary = wordSet(left.analysis.summary);
  const rightSummary = wordSet(right.analysis.summary);
  return jaccard(leftSummary, rightSummary) >= 0.82;
}

function validationError(issues: string[]): LlmError {
  return new LlmError("Editorial plan output failed schema validation.", {
    context: { retryable: false, kind: "invalid-editorial-plan", issues }
  });
}

export function validateEditorialPlan(
  value: unknown,
  items: EditionArticle[],
  options: Pick<EditorialSelectionOptions, "language" | "maxArticles" | "maxPerTopic">
): EditorialPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw validationError(["editorial plan must be a JSON object"]);
  }

  const record = value as Record<string, unknown>;
  const issues: string[] = [];
  for (const key of Object.keys(record)) {
    if (!EXPECTED_FIELDS.has(key)) issues.push(`unexpected field ${key}`);
  }

  const overview = typeof record.overview === "string" ? record.overview.trim() : "";
  if (!overview) issues.push("overview must be a non-empty string");
  if (overview.length > 12_000) issues.push("overview exceeds 12000 characters");
  if (overview && options.language.toLocaleLowerCase("und").startsWith("ru")) {
    const letters = overview.match(/\p{L}/gu) ?? [];
    const cyrillic = overview.match(/\p{Script=Cyrillic}/gu) ?? [];
    if (letters.length >= 8 && cyrillic.length / letters.length < 0.3) {
      issues.push("overview must be written in Russian for language 'ru'");
    }
  }

  if (!Array.isArray(record.selectedArticleIds)) {
    issues.push("selectedArticleIds must be an array");
    throw validationError(issues);
  }
  if (record.selectedArticleIds.length === 0) issues.push("selectedArticleIds must not be empty");
  if (record.selectedArticleIds.length > options.maxArticles) {
    issues.push(`selectedArticleIds must contain at most ${options.maxArticles} ids`);
  }

  const byId = new Map(items.map((item) => [item.article.id, item]));
  const seen = new Set<number>();
  const selected: EditionArticle[] = [];
  const ids: number[] = [];
  const topicCounts = new Map<string, number>();

  for (const [index, rawId] of record.selectedArticleIds.entries()) {
    if (!Number.isSafeInteger(rawId)) {
      issues.push(`selectedArticleIds[${index}] must be an integer`);
      continue;
    }
    const id = Number(rawId);
    if (seen.has(id)) {
      issues.push(`selectedArticleIds contains duplicate id ${id}`);
      continue;
    }
    const item = byId.get(id);
    if (!item) {
      issues.push(`selectedArticleIds contains unknown id ${id}`);
      continue;
    }

    const topic = primaryTopic(item);
    if (topic) {
      const count = (topicCounts.get(topic) ?? 0) + 1;
      topicCounts.set(topic, count);
      if (count > options.maxPerTopic) {
        issues.push(`primary topic ${JSON.stringify(topic)} exceeds limit ${options.maxPerTopic}`);
      }
    }

    for (const prior of selected) {
      if (areNearDuplicateStories(prior, item)) {
        issues.push(`selected ids ${prior.article.id} and ${id} are near-duplicate coverage`);
        break;
      }
    }

    seen.add(id);
    selected.push(item);
    ids.push(id);
  }

  if (issues.length > 0) throw validationError(issues);
  return { overview, selectedArticleIds: ids };
}

export function parseEditorialPlan(
  raw: string,
  items: EditionArticle[],
  options: Pick<EditorialSelectionOptions, "language" | "maxArticles" | "maxPerTopic">
): EditorialPlan {
  return validateEditorialPlan(parseJsonObject<Record<string, unknown>>(raw), items, options);
}

function freshnessBonus(item: EditionArticle, newestPublishedAt: number): number {
  const publishedAt = new Date(item.article.publishedAt).getTime();
  if (Number.isNaN(publishedAt) || !Number.isFinite(newestPublishedAt)) return 0;
  const ageHours = Math.max(0, newestPublishedAt - publishedAt) / 3_600_000;
  return Math.max(0, 1 - ageHours / 24) * 10;
}

export function fallbackEditorialScore(item: EditionArticle, newestPublishedAt: number): number {
  return item.analysis.importance
    + (item.analysis.recommended ? 15 : 0)
    + freshnessBonus(item, newestPublishedAt);
}

function fallbackOverview(selected: EditionArticle[], language: string): string {
  const summaries = selected
    .slice(0, 4)
    .map((item) => item.analysis.summary.trim())
    .filter(Boolean);
  if (!summaries.length) {
    const titles = selected.map((item) => item.article.title.trim()).filter(Boolean);
    return titles.join(". ") || (language.toLocaleLowerCase("und").startsWith("ru") ? "Утренний выпуск." : "Morning edition.");
  }

  const body = summaries.join("\n\n");
  return language.toLocaleLowerCase("und").startsWith("ru") ? `Главное к утру:\n\n${body}` : body;
}

export function deterministicEditorialPlan(
  items: EditionArticle[],
  options: Pick<EditorialSelectionOptions, "language" | "maxArticles" | "maxPerTopic">
): EditorialPlan {
  const timestamps = items
    .map((item) => new Date(item.article.publishedAt).getTime())
    .filter((value) => Number.isFinite(value));
  const newestPublishedAt = timestamps.length ? Math.max(...timestamps) : Number.NaN;

  const ranked = [...items].sort((left, right) => {
    const scoreDifference = fallbackEditorialScore(right, newestPublishedAt) - fallbackEditorialScore(left, newestPublishedAt);
    if (scoreDifference !== 0) return scoreDifference;
    const publishedDifference = new Date(right.article.publishedAt).getTime() - new Date(left.article.publishedAt).getTime();
    if (Number.isFinite(publishedDifference) && publishedDifference !== 0) return publishedDifference;
    return left.article.id - right.article.id;
  });

  const selected: EditionArticle[] = [];
  const topicCounts = new Map<string, number>();
  for (const item of ranked) {
    if (selected.length >= options.maxArticles) break;
    const topic = primaryTopic(item);
    if (topic && (topicCounts.get(topic) ?? 0) >= options.maxPerTopic) continue;
    if (selected.some((prior) => areNearDuplicateStories(prior, item))) continue;

    selected.push(item);
    if (topic) topicCounts.set(topic, (topicCounts.get(topic) ?? 0) + 1);
  }

  return {
    overview: fallbackOverview(selected, options.language),
    selectedArticleIds: selected.map((item) => item.article.id)
  };
}

export async function selectEditorialPlan(
  items: EditionArticle[],
  provider: LlmProvider,
  options: EditorialSelectionOptions
): Promise<{ plan: EditorialPlan; metadata: EditorialMetadata }> {
  const log = logger.child({
    component: "editorial-selection",
    modelName: options.modelName,
    promptVersion: EDITORIAL_PROMPT_VERSION
  });

  try {
    const completion = await provider.complete([
      { role: "system", content: "You are a rigorous personal newspaper editor. Return only JSON when requested." },
      { role: "user", content: editorialPrompt(items, options.language, options.maxArticles, options.maxPerTopic) }
    ]);
    const plan = parseEditorialPlan(completion.content, items, options);
    return {
      plan,
      metadata: {
        modelName: options.modelName,
        promptVersion: EDITORIAL_PROMPT_VERSION,
        selectionMethod: "llm"
      }
    };
  } catch (error) {
    log.warn("editorial model failed; using deterministic fallback", { error });
    return {
      plan: deterministicEditorialPlan(items, options),
      metadata: {
        modelName: options.modelName,
        promptVersion: EDITORIAL_PROMPT_VERSION,
        selectionMethod: "fallback"
      }
    };
  }
}
