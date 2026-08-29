import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import { ExtractionError, FetchError } from "../errors.js";
import { fetchWithRetry, type FetchFunction, type SleepFunction } from "../http.js";
import { logger } from "../logging.js";
import { normalizeMeduzaUrl, tryNormalizeMeduzaUrl } from "../sources/meduza-url.js";
import type { Article, DiscoveredItem } from "../types.js";
import { sha256 } from "../utils/hash.js";

const MEDUZA_REMOVE_SELECTORS = [
  '[data-testid="related-materials"]',
  '[data-testid="subscription-banner"]',
  '[data-testid="article-footer"]',
  ".Banner-root",
  ".Related-root"
];

export interface FetchAndExtractOptions {
  language?: string;
  userAgent: string;
  timeoutMs: number;
  retries: number;
  retryBaseDelayMs: number;
  minArticleChars: number;
  fetchFn?: FetchFunction;
  sleep?: SleepFunction;
}

export interface ExtractHtmlOptions {
  language?: string;
  minArticleChars?: number;
}

function cleanMeduzaDocument(document: Document): void {
  for (const selector of MEDUZA_REMOVE_SELECTORS) {
    document.querySelectorAll(selector).forEach((element) => element.remove());
  }
}

function firstAttribute(document: Document, candidates: Array<[string, string]>): string | undefined {
  for (const [selector, attribute] of candidates) {
    const value = document.querySelector(selector)?.getAttribute(attribute)?.trim();
    if (value) return value;
  }
  return undefined;
}

function extractCanonicalUrl(document: Document, item: DiscoveredItem): string {
  const canonical = firstAttribute(document, [["link[rel~='canonical' i]", "href"]]);
  if (item.sourceId === "meduza") {
    return (canonical && tryNormalizeMeduzaUrl(canonical, item.url)) ?? normalizeMeduzaUrl(item.url);
  }
  if (!canonical) return item.url;
  try {
    return new URL(canonical, item.url).toString();
  } catch {
    return item.url;
  }
}

function extractPublishedAt(document: Document, fallback: string): string {
  const raw = firstAttribute(document, [
    ["meta[property='article:published_time']", "content"],
    ["meta[name='article:published_time']", "content"],
    ["meta[itemprop='datePublished']", "content"],
    ["meta[name='date']", "content"],
    ["time[datetime]", "datetime"]
  ]);
  if (!raw) return fallback;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function extractAuthor(document: Document, readabilityByline: string | null | undefined): string | undefined {
  return firstAttribute(document, [
    ["meta[name='author']", "content"],
    ["meta[property='article:author']", "content"]
  ]) || readabilityByline?.trim() || undefined;
}

function extractTitle(document: Document, readabilityTitle: string | null | undefined, fallback: string): string {
  return readabilityTitle?.trim()
    || firstAttribute(document, [["meta[property='og:title']", "content"]])
    || fallback;
}

export function extractArticleFromHtml(
  item: DiscoveredItem,
  html: string,
  options: ExtractHtmlOptions = {}
): Article {
  const language = options.language ?? "ru";
  const minArticleChars = options.minArticleChars ?? 200;

  try {
    const dom = new JSDOM(html, { url: item.url });
    const document = dom.window.document;
    if (item.sourceId === "meduza") cleanMeduzaDocument(document);

    const canonicalUrl = extractCanonicalUrl(document, item);
    const publishedAt = extractPublishedAt(document, item.publishedAt);
    const parsed = new Readability(document).parse();
    if (!parsed?.textContent || !parsed.content) {
      throw new ExtractionError(`Readability could not extract article content from ${item.url}.`, {
        context: { url: item.url, sourceId: item.sourceId }
      });
    }

    const text = parsed.textContent.replace(/\n{3,}/g, "\n\n").trim();
    const textLength = text.replace(/\s+/g, " ").length;
    if (textLength < minArticleChars) {
      throw new ExtractionError(
        `Extracted content from ${item.url} is too short to be an article (${textLength} characters; minimum ${minArticleChars}).`,
        { context: { url: item.url, sourceId: item.sourceId, textLength, minArticleChars } }
      );
    }

    return {
      sourceId: item.sourceId,
      externalId: item.externalId,
      url: canonicalUrl,
      title: extractTitle(document, parsed.title, item.title),
      author: extractAuthor(document, parsed.byline),
      publishedAt,
      language,
      text,
      contentHtml: parsed.content,
      contentHash: sha256(text),
      fetchedAt: new Date().toISOString()
    };
  } catch (error) {
    if (error instanceof ExtractionError) throw error;
    throw new ExtractionError(`Failed to extract article content from ${item.url}.`, {
      cause: error,
      context: { url: item.url, sourceId: item.sourceId }
    });
  }
}

export async function fetchAndExtract(item: DiscoveredItem, options: FetchAndExtractOptions): Promise<Article> {
  const log = logger.child({ component: "article-fetch", sourceId: item.sourceId, url: item.url });
  const response = await fetchWithRetry(item.url, {
    userAgent: options.userAgent,
    timeoutMs: options.timeoutMs,
    retries: options.retries,
    retryBaseDelayMs: options.retryBaseDelayMs,
    fetchFn: options.fetchFn,
    sleep: options.sleep,
    request: {
      headers: { accept: "text/html,application/xhtml+xml" }
    },
    onRetry: ({ attempt, nextAttempt, delayMs, status, error }) => {
      log.warn("retrying article request", { attempt, nextAttempt, delayMs, status, error });
    }
  });

  const contentType = response.headers.get("content-type");
  if (contentType && !/\b(?:text\/html|application\/xhtml\+xml)\b/i.test(contentType)) {
    throw new ExtractionError(`Article response from ${item.url} is not HTML (${contentType}).`, {
      context: { url: item.url, sourceId: item.sourceId, contentType }
    });
  }

  let html: string;
  try {
    html = await response.text();
  } catch (cause) {
    throw new FetchError(`Failed to read article response body for ${item.url}.`, {
      cause,
      context: { url: item.url, sourceId: item.sourceId }
    });
  }

  return extractArticleFromHtml(item, html, {
    language: options.language,
    minArticleChars: options.minArticleChars
  });
}
