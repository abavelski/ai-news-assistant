import Parser from "rss-parser";
import type { AppConfig } from "../config.js";
import { ConfigurationError, ExtractionError, FetchError } from "../errors.js";
import { fetchAndExtract } from "../extraction/readability.js";
import { fetchWithRetry, type FetchFunction, type SleepFunction } from "../http.js";
import { logger } from "../logging.js";
import type { Article, DiscoveredItem } from "../types.js";
import type { SourceConfig } from "./config.js";
import { validateHttpUrl, validateNonSecretSettings } from "./config.js";
import { tryNormalizeMeduzaUrl } from "./meduza-url.js";
import type { SourceAdapter } from "./source.js";

export const MEDUZA_SOURCE_TYPE = "meduza";
export const MEDUZA_SETTINGS_VERSION = 1;

export interface MeduzaSettings extends Record<string, unknown> {
  rssUrl: string;
}

export interface MeduzaSourceDependencies {
  fetchFn?: FetchFunction;
  sleep?: SleepFunction;
}

function isSourceConfig(value: unknown): value is SourceConfig<MeduzaSettings> {
  return Boolean(value && typeof value === "object" && "id" in value && "settings" in value && "type" in value);
}

export function validateMeduzaSettings(value: unknown, settingsVersion = MEDUZA_SETTINGS_VERSION): MeduzaSettings {
  if (settingsVersion !== MEDUZA_SETTINGS_VERSION) {
    throw new ConfigurationError(
      `Meduza settings version ${settingsVersion} is not supported; expected ${MEDUZA_SETTINGS_VERSION}.`
    );
  }
  const settings = validateNonSecretSettings(value);
  const keys = Object.keys(settings);
  if (keys.length !== 1 || keys[0] !== "rssUrl") {
    throw new ConfigurationError("Meduza settings must contain exactly one field: rssUrl.");
  }
  return { rssUrl: validateHttpUrl(settings.rssUrl, "Meduza rssUrl") };
}

export class MeduzaSource implements SourceAdapter {
  readonly id: string;
  readonly type = MEDUZA_SOURCE_TYPE;
  private readonly settings: MeduzaSettings;
  private readonly dependencies: MeduzaSourceDependencies;
  private readonly parser = new Parser();
  private readonly log;

  constructor(config: AppConfig, dependencies?: MeduzaSourceDependencies);
  constructor(config: AppConfig, sourceConfig: SourceConfig<MeduzaSettings>, dependencies?: MeduzaSourceDependencies);
  constructor(
    private readonly config: AppConfig,
    sourceConfigOrDependencies: SourceConfig<MeduzaSettings> | MeduzaSourceDependencies = {},
    dependencies: MeduzaSourceDependencies = {}
  ) {
    if (isSourceConfig(sourceConfigOrDependencies)) {
      this.id = sourceConfigOrDependencies.id;
      this.settings = validateMeduzaSettings(sourceConfigOrDependencies.settings, sourceConfigOrDependencies.settingsVersion);
      this.dependencies = dependencies;
    } else {
      this.id = "meduza";
      this.settings = { rssUrl: config.meduzaRssUrl };
      this.dependencies = sourceConfigOrDependencies;
    }
    this.log = logger.child({ component: "source", sourceId: this.id, sourceType: this.type });
  }

  async discover(since: Date): Promise<DiscoveredItem[]> {
    const response = await fetchWithRetry(this.settings.rssUrl, {
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
        context: { sourceId: this.id, url: this.settings.rssUrl }
      });
    }

    let feed: Awaited<ReturnType<typeof this.parser.parseString>>;
    try {
      feed = await this.parser.parseString(xml);
    } catch (cause) {
      throw new ExtractionError(`Failed to parse RSS feed for source ${this.id}.`, {
        cause,
        context: { sourceId: this.id, url: this.settings.rssUrl }
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
        publishedAt: date.toISOString(),
        contentKind: "article",
        context: {}
      });
      if (discovered.length >= this.config.maxArticles) break;
    }

    return discovered;
  }

  async materialize(item: DiscoveredItem): Promise<Article> {
    return fetchAndExtract(item, {
      language: this.config.editionLanguage,
      userAgent: this.config.httpUserAgent,
      timeoutMs: this.config.httpTimeoutMs,
      retries: this.config.httpRetries,
      retryBaseDelayMs: this.config.httpRetryBaseDelayMs,
      minArticleChars: this.config.minArticleChars,
      fetchFn: this.dependencies.fetchFn,
      sleep: this.dependencies.sleep,
      meduzaMode: true
    });
  }
}
