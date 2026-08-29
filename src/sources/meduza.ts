import Parser from "rss-parser";
import type { AppConfig } from "../config.js";
import { FetchError } from "../errors.js";
import type { DiscoveredItem } from "../types.js";
import type { NewsSource } from "./source.js";

export class MeduzaSource implements NewsSource {
  readonly id = "meduza";
  private readonly parser = new Parser();

  constructor(private readonly config: AppConfig) {}

  async discover(since: Date): Promise<DiscoveredItem[]> {
    try {
      const feed = await this.parser.parseURL(this.config.meduzaRssUrl);
      return feed.items
        .flatMap((item): DiscoveredItem[] => {
          const url = item.link;
          const title = item.title;
          const publishedAt = item.isoDate ?? item.pubDate;
          if (!url || !title || !publishedAt) return [];
          const date = new Date(publishedAt);
          if (Number.isNaN(date.getTime()) || date < since) return [];
          return [{
            sourceId: this.id,
            externalId: item.guid ?? url,
            url,
            title,
            publishedAt: date.toISOString()
          }];
        })
        .slice(0, this.config.maxArticles);
    } catch (cause) {
      throw new FetchError(`Failed to fetch RSS feed for source ${this.id}.`, {
        cause,
        context: { sourceId: this.id, url: this.config.meduzaRssUrl }
      });
    }
  }
}
