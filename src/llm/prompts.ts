import type { Article, EditionArticle } from "../types.js";

export const ARTICLE_ANALYSIS_PROMPT_VERSION = "article-analysis-v1";
export const EDITORIAL_PROMPT_VERSION = "editorial-v1";
const OMISSION_MARKER = "\n\n[… middle omitted …]\n\n";

function graphemes(value: string): string[] {
  const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
  return Array.from(segmenter.segment(value), (entry) => entry.segment);
}

export function boundedArticleText(text: string, maxCharacters: number): string {
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 32) {
    throw new RangeError("maxCharacters must be an integer of at least 32.");
  }

  const units = graphemes(text);
  if (units.length <= maxCharacters) return text;

  const markerUnits = graphemes(OMISSION_MARKER);
  const available = Math.max(2, maxCharacters - markerUnits.length);
  const headCount = Math.max(1, Math.ceil(available * 0.7));
  const tailCount = Math.max(1, available - headCount);
  return units.slice(0, headCount).join("") + OMISSION_MARKER + units.slice(-tailCount).join("");
}

export function articleAnalysisPrompt(article: Article, language: string, maxArticleChars = 28_000): string {
  const clipped = boundedArticleText(article.text, maxArticleChars);
  return `Analyze this news article for a private morning news digest.\n\n` +
    `Prompt version: ${ARTICLE_ANALYSIS_PROMPT_VERSION}\n` +
    `Return ONLY valid JSON with exactly these fields:\n` +
    `{"summary":"...","topics":["..."],"importance":0,"recommended":true,"reason":"...","keyFacts":["..."]}\n\n` +
    `Rules:\n- Write summary/reason/keyFacts in language '${language}'.\n` +
    `- importance must be an integer from 0 to 100.\n` +
    `- topics and keyFacts must contain strings only.\n` +
    `- Separate factual summary from opinion.\n- Do not invent facts.\n` +
    `- Prefer substance over clickbait.\n\nTitle: ${article.title}\nURL: ${article.url}\n\n${clipped}`;
}

export function editorialPrompt(
  items: EditionArticle[],
  language: string,
  maxArticles: number,
  maxPerTopic: number
): string {
  const payload = items.map(({ article, analysis }) => ({
    id: article.id,
    sourceId: article.sourceId,
    title: article.title,
    publishedAt: article.publishedAt,
    importance: analysis.importance,
    recommended: analysis.recommended,
    topics: analysis.topics,
    summary: analysis.summary,
    reason: analysis.reason,
    keyFacts: analysis.keyFacts
  }));

  return `Act as the conservative editor of a private morning newspaper.\n` +
    `Editorial prompt version: ${EDITORIAL_PROMPT_VERSION}\n` +
    `Select a compact, varied set of up to ${maxArticles} meaningful stories.\n` +
    `Return ONLY valid JSON with exactly this shape: {"overview":"...","selectedArticleIds":[1,2,3]}.\n` +
    `Rules:\n` +
    `- Write overview in language '${language}'.\n` +
    `- selectedArticleIds must contain unique ids from INPUT only.\n` +
    `- Avoid duplicate or near-duplicate coverage by comparing titles, summaries, topics, reasons, and key facts.\n` +
    `- Prefer recommended, important, fresh stories while keeping topic variety.\n` +
    `- Select at most ${maxPerTopic} stories sharing the same primary topic.\n` +
    `- Do not request or infer full article bodies; decide only from the metadata in INPUT.\n\n` +
    `INPUT:\n${JSON.stringify(payload)}`;
}
