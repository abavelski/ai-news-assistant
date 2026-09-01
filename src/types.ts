export type ContentKind = "article" | "discussion";

export type SourceContextValue = string | number | boolean | null;
export type SourceContext = Record<string, SourceContextValue>;

export interface DiscoveredItem {
  sourceId: string;
  externalId: string;
  url: string;
  title: string;
  publishedAt: string;
  contentKind: ContentKind;
  context: SourceContext;
}

export interface Article {
  id?: number;
  sourceId: string;
  externalId: string;
  url: string;
  title: string;
  author?: string;
  publishedAt: string;
  language: string;
  contentKind: ContentKind;
  sourceContext: SourceContext;
  text: string;
  contentHtml: string;
  contentHash: string;
  fetchedAt: string;
}

export interface AnalysisIdentity {
  modelName: string;
  promptVersion: string;
  analysisVersion: string;
}

export interface ArticleAnalysis extends AnalysisIdentity {
  articleId: number;
  summary: string;
  topics: string[];
  importance: number;
  recommended: boolean;
  reason: string;
  keyPoints: string[];
  analyzedAt: string;
  latencyMs: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface EditorialPlan {
  overview: string;
  selectedArticleIds: number[];
}

export interface EditorialMetadata {
  modelName: string;
  promptVersion: string;
  selectionMethod: "llm" | "fallback";
}

export interface EditionArticle {
  article: Article & { id: number };
  analysis: ArticleAnalysis;
}

export interface EditionResult {
  editionDate: string;
  epubPath: string;
  manifestPath: string;
  selectedCount: number;
}
