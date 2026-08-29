import type { Article, EditionArticle } from "../types.js";

export function articleAnalysisPrompt(article: Article, language: string): string {
  const clipped = article.text.slice(0, 28_000);
  return `Analyze this news article for a private morning news digest.\n\n` +
    `Return ONLY valid JSON with this exact shape:\n` +
    `{\"summary\":\"...\",\"topics\":[\"...\"],\"importance\":0,\"recommended\":true,\"reason\":\"...\",\"keyFacts\":[\"...\"]}\n\n` +
    `Rules:\n- Write summary/reason/keyFacts in language '${language}'.\n` +
    `- importance is an integer from 0 to 100.\n` +
    `- Separate factual summary from opinion.\n- Do not invent facts.\n` +
    `- Prefer substance over clickbait.\n\nTitle: ${article.title}\nURL: ${article.url}\n\n${clipped}`;
}

export function editorialPrompt(items: EditionArticle[], language: string, maxArticles: number): string {
  const payload = items.map(({ article, analysis }) => ({
    id: article.id,
    title: article.title,
    publishedAt: article.publishedAt,
    importance: analysis.importance,
    topics: analysis.topics,
    summary: analysis.summary,
    reason: analysis.reason
  }));

  return `Act as the editor of a private morning newspaper.\n` +
    `Select up to ${maxArticles} stories, remove near-duplicate or low-value incremental stories, and order the result for a pleasant morning read.\n` +
    `Return ONLY valid JSON: {\"overview\":\"...\",\"selectedArticleIds\":[1,2,3]}.\n` +
    `The overview must be in language '${language}' and summarize the morning in a few paragraphs.\n` +
    `Only choose ids that appear in the input.\n\nINPUT:\n${JSON.stringify(payload)}`;
}
