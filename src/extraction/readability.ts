import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import { ExtractionError, FetchError } from "../errors.js";
import type { Article, DiscoveredItem } from "../types.js";
import { sha256 } from "../utils/hash.js";

export async function fetchAndExtract(item: DiscoveredItem, language = "ru"): Promise<Article> {
  let response: Response;
  try {
    response = await fetch(item.url, {
      headers: {
        "user-agent": "ai-news-assistant/0.1 (+personal self-hosted reader)",
        accept: "text/html,application/xhtml+xml"
      },
      signal: AbortSignal.timeout(20_000)
    });
  } catch (cause) {
    throw new FetchError(`Failed to fetch article ${item.url}.`, {
      cause,
      context: { url: item.url, sourceId: item.sourceId }
    });
  }

  if (!response.ok) {
    throw new FetchError(`Failed to fetch article ${item.url}: HTTP ${response.status} ${response.statusText}.`, {
      context: { url: item.url, sourceId: item.sourceId, status: response.status }
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

  try {
    const dom = new JSDOM(html, { url: item.url });
    const parsed = new Readability(dom.window.document).parse();
    if (!parsed?.textContent || !parsed.content) {
      throw new ExtractionError(`Readability could not extract article content from ${item.url}.`, {
        context: { url: item.url, sourceId: item.sourceId }
      });
    }

    const text = parsed.textContent.replace(/\n{3,}/g, "\n\n").trim();
    return {
      sourceId: item.sourceId,
      externalId: item.externalId,
      url: item.url,
      title: parsed.title || item.title,
      author: parsed.byline || undefined,
      publishedAt: item.publishedAt,
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
