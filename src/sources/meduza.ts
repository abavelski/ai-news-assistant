import Parser from "rss-parser";
import type { AppConfig } from "../config.js";
import { ExtractionError, FetchError } from "../errors.js";
import { fetchWithRetry, type FetchFunction, type SleepFunction } from "../http.js";
import { logger } from "../logging.js";
import type { DiscoveredItem } from "../types.js";
import { tryNormalizeMeduzaUrl } from "./meduza-url.js";
import type { NewsSource } from "./source.js";

interface MeduzaSourceDependencies {
  fetchFn?: FetchFunction;
  sleep?: SleepFunction;
}

export class MeduzaSource implements NewsSource {
  readonly id = "meduza";
  private readonly parser = new Parser();
  private readonly log = logger.child({ component: "source", sourceId: this.id });

  constructor(
    private readonly config: AppConfig,
    private readonly dependencies: MeduzaSourceDependencies = {}
  ) {}

  async discover(since: Date): Promise<DiscoveredItem[]> {
    const response = await fetchWithRetry(this.config.meduzaRssUrl, {
      userAgent: this.config.httpUserAgent,
      timeoutMs: this.config.httpTimeoutMs,
      retries: this.config.httpRetries,
      retryBaseDelayMs: this.config.httpRetryBaseDelayMs,
      fetchFn: this.dependencies.fetchFn,
      sleep: this.dependencies.sleep,
      request: {
        headers: { accept: "application/rss+xml, application/xml, text/xml;q=0.9" }
      },
      onRetry: ({ attempt, nextAttempt, delayMs, status, error }) => {
        this.log.warn("retrying RSS request", { attempt, nextAttempt, delayMs, status, error });
      }
    });

    let xml: string;
    try {
      xml = await response.text();
    } catch (cause) {
      throw new FetchError(`Failed to read RSS response body for source ${this.id}.`, {
        cause,
        context: { sourceId: this.id, url: this.config.meduzaRssUrl }
      });
    }

    let feed: Awaited<ReturnType<typeof this.parser.parseString>>;
    try {
      feed = await this.parser.parseString(xml);
    } catch (cause) {
      throw new ExtractionError(`Failed to parse RSS feed for source ${this.id}.`, {
        cause,
        context: { sourceId: this.id, url: this.config.meduzaRssUrl }
      });
    }

    const discovered: DiscoveredItem[] = [];
    const seenUrls = new Set<string>();

    for (const item of feed.items) {
      const normalizedUrl = item.link ? tryNormalizeMeduzaUrl(item.link) : undefined;
      const title = item.title?.trim();
      const publishedAt = item.isoDate ?? item.pubDate;
      if (!normalizedUrl || !title || !publishedAt) continue;

      const date = new Date(publishedAt);
      if (Number.isNaN(date.getTime()) || date < since || seenUrls.has(normalizedUrl)) continue;

      seenUrls.add(normalizedUrl);
      discovered.push({
        sourceId: this.id,
        externalId: item.guid?.trim() || normalizedUrl,
        url: normalizedUrl,
        title,
        publishedAt: date.toISOString()
      });
      if (discovered.length >= this.config.maxArticles) break;
    }

    return discovered;
  }
}
