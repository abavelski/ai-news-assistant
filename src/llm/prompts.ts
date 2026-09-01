import type { Article, ContentKind, EditionArticle } from "../types.js";

export const ARTICLE_ANALYSIS_PROMPT_VERSION = "content-analysis-v2";
export const DISCUSSION_ANALYSIS_PROMPT_VERSION = "discussion-analysis-v1";
export const CONTENT_ANALYSIS_PROMPT_VERSION = ARTICLE_ANALYSIS_PROMPT_VERSION;
export const EDITORIAL_PROMPT_VERSION = "editorial-v3";
const OMISSION_MARKER = "\n\n[… middle omitted …]\n\n";

function graphemes(value: string): string[] {
  const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
  return Array.from(segmenter.segment(value), (entry) => entry.segment);
}

export function boundedContentText(text: string, maxCharacters: number): string {
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

export const boundedArticleText = boundedContentText;

export function promptVersionForContentKind(kind: ContentKind): string {
  return kind === "discussion" ? DISCUSSION_ANALYSIS_PROMPT_VERSION : ARTICLE_ANALYSIS_PROMPT_VERSION;
}

function safeAnalysisContext(content: Article): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(content.sourceContext).filter(([key]) => !/(?:author|username)/i.test(key))
  );
}

export function contentAnalysisPrompt(content: Article, language: string, maxContentChars = 28_000): string {
  const clipped = boundedContentText(content.text, maxContentChars);
  const promptVersion = promptVersionForContentKind(content.contentKind);
  const context = safeAnalysisContext(content);

  const rules = content.contentKind === "discussion"
    ? `- Describe what the thread is about and summarize the substantive discussion, not just the post title.\n` +
      `- Identify the main viewpoints/themes, areas of agreement and disagreement, practical advice or references when present, and important caveats.\n` +
      `- Treat participant claims and anecdotes as viewpoints, NOT verified facts.\n` +
      `- Do not infer community consensus from a bounded sample of comments.\n` +
      `- keyPoints must be neutral discussion takeaways, not claims of factual verification.\n`
    : `- Separate factual summary from opinion.\n` +
      `- Prefer factual takeaways in keyPoints.\n`;

  return `Analyze this ${content.contentKind} for a private morning digest.\n\n` +
    `Prompt version: ${promptVersion}\n` +
    `Return ONLY valid JSON with exactly these fields:\n` +
    `{"summary":"...","topics":["..."],"importance":0,"recommended":true,"reason":"...","keyPoints":["..."]}\n\n` +
    `Rules:\n- Write summary/reason/keyPoints in language '${language}'.\n` +
    `- importance must be an integer from 0 to 100.\n` +
    `- topics and keyPoints must contain strings only.\n` +
    rules +
    `- Do not invent information.\n- Prefer substance over clickbait.\n\n` +
    `Content kind: ${content.contentKind}\nTitle: ${content.title}\nURL: ${content.url}\n` +
    `Source context: ${JSON.stringify(context)}\n\n${clipped}`;
}

export const articleAnalysisPrompt = contentAnalysisPrompt;

export function editorialPrompt(
  items: EditionArticle[],
  language: string,
  maxArticles: number,
  maxPerTopic: number,
  maxPerSource: number,
  maxDiscussions: number
): string {
  const payload = items.map(({ article, analysis }) => ({
    id: article.id,
    sourceId: article.sourceId,
    contentKind: article.contentKind,
    sourceContext: safeAnalysisContext(article),
    title: article.title,
    publishedAt: article.publishedAt,
    importance: analysis.importance,
    recommended: analysis.recommended,
    topics: analysis.topics,
    summary: analysis.summary,
    reason: analysis.reason,
    keyPoints: analysis.keyPoints
  }));

  return `Act as the conservative editor of a private morning newspaper.\n` +
    `Editorial prompt version: ${EDITORIAL_PROMPT_VERSION}\n` +
    `Select a compact, varied set of up to ${maxArticles} meaningful items.\n` +
    `Return ONLY valid JSON with exactly this shape: {"overview":"...","selectedArticleIds":[1,2,3]}.\n` +
    `Rules:\n` +
    `- Write overview in language '${language}'.\n` +
    `- selectedArticleIds must contain unique ids from INPUT only.\n` +
    `- Avoid duplicate or near-duplicate coverage by comparing titles, summaries, topics, reasons, and key points.\n` +
    `- Prefer recommended, important, fresh items while keeping topic and source variety.\n` +
    `- Select at most ${maxPerTopic} items sharing the same primary topic.\n` +
    `- Select at most ${maxPerSource} items from the same sourceId.\n` +
    `- Select at most ${maxDiscussions} discussion items across all sources.\n` +
    `- Treat discussion summaries as discussion context, not automatically verified facts.\n` +
    `- Do not request or infer full content bodies; decide only from the metadata in INPUT.\n\n` +
    `INPUT:\n${JSON.stringify(payload)}`;
}
