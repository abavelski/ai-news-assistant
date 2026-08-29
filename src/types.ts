export interface DiscoveredItem {
  sourceId: string;
  externalId: string;
  url: string;
  title: string;
  publishedAt: string;
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
  keyFacts: string[];
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
