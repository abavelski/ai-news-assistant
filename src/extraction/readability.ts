import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import type { Article, DiscoveredItem } from "../types.js";
import { sha256 } from "../utils/hash.js";

export async function fetchAndExtract(item: DiscoveredItem, language = "ru"): Promise<Article> {
  const response = await fetch(item.url, {
    headers: {
      "user-agent": "ai-news-assistant/0.1 (+personal self-hosted reader)",
      accept: "text/html,application/xhtml+xml"
    },
    signal: AbortSignal.timeout(20_000)
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${item.url}: ${response.status} ${response.statusText}`);
  }

  const html = await response.text();
  const dom = new JSDOM(html, { url: item.url });
  const parsed = new Readability(dom.window.document).parse();
  if (!parsed?.textContent || !parsed.content) {
    throw new Error(`Readability could not extract article: ${item.url}`);
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
}
