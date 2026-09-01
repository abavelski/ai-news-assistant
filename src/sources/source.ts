import { ConfigurationError, ExtractionError } from "../errors.js";
import type { Article, ContentKind, DiscoveredItem, SourceContext } from "../types.js";
import { validateNonSecretSettings } from "./config.js";

const CONTENT_KINDS = new Set<ContentKind>(["article", "discussion"]);
const SOURCE_CONTEXT_KEY = /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/;
const MAX_SOURCE_CONTEXT_KEYS = 32;
const MAX_SOURCE_CONTEXT_STRING = 2_000;
const MAX_SOURCE_CONTEXT_BYTES = 8_192;

export interface SourceAdapter {
  readonly id: string;
  readonly type: string;
  discover(since: Date): Promise<DiscoveredItem[]>;
  materialize(item: DiscoveredItem): Promise<Article>;
}

export type NewsSource = SourceAdapter;

export function validateContentKind(value: unknown): ContentKind {
  if (typeof value !== "string" || !CONTENT_KINDS.has(value as ContentKind)) {
    throw new ConfigurationError(`Unsupported content kind ${JSON.stringify(value)}.`);
  }
  return value as ContentKind;
}

export function validateSourceContext(value: unknown): SourceContext {
  const safeObject = validateNonSecretSettings(value);
  const entries = Object.entries(safeObject);
  if (entries.length > MAX_SOURCE_CONTEXT_KEYS) {
    throw new ConfigurationError(`Source context must contain at most ${MAX_SOURCE_CONTEXT_KEYS} keys.`);
  }
  const context: SourceContext = {};
  for (const [key, entry] of entries) {
    if (!SOURCE_CONTEXT_KEY.test(key)) {
      throw new ConfigurationError(`Invalid source-context key ${JSON.stringify(key)}.`);
    }
    if (entry === null || typeof entry === "number" || typeof entry === "boolean") {
      if (typeof entry === "number" && !Number.isFinite(entry)) {
        throw new ConfigurationError(`Source-context value ${key} must be finite.`);
      }
      context[key] = entry;
      continue;
    }
    if (typeof entry === "string") {
      if (entry.length > MAX_SOURCE_CONTEXT_STRING) {
        throw new ConfigurationError(`Source-context string ${key} exceeds ${MAX_SOURCE_CONTEXT_STRING} characters.`);
      }
      context[key] = entry;
      continue;
    }
    throw new ConfigurationError(`Source-context value ${key} must be a string, number, boolean, or null.`);
  }
  if (Buffer.byteLength(JSON.stringify(context), "utf8") > MAX_SOURCE_CONTEXT_BYTES) {
    throw new ConfigurationError(`Source context must not exceed ${MAX_SOURCE_CONTEXT_BYTES} UTF-8 bytes.`);
  }
  return context;
}

export function validateDiscoveredItem(item: DiscoveredItem, source: SourceAdapter): DiscoveredItem {
  if (item.sourceId !== source.id) {
    throw new ExtractionError(`Source ${source.id} discovered an item owned by ${item.sourceId}.`, {
      context: { sourceId: source.id, itemSourceId: item.sourceId }
    });
  }
  const publishedAt = new Date(item.publishedAt);
  if (Number.isNaN(publishedAt.getTime())) {
    throw new ExtractionError(`Source ${source.id} returned an invalid publication timestamp.`, {
      context: { sourceId: source.id, externalId: item.externalId }
    });
  }
  return {
    ...item,
    contentKind: validateContentKind(item.contentKind),
    context: validateSourceContext(item.context)
  };
}

export function validateMaterializedContent(article: Article, item: DiscoveredItem, source: SourceAdapter): Article {
  if (article.sourceId !== source.id || article.externalId !== item.externalId) {
    throw new ExtractionError(`Source ${source.id} materialized content with inconsistent identity.`, {
      context: {
        sourceId: source.id,
        itemExternalId: item.externalId,
        materializedSourceId: article.sourceId,
        materializedExternalId: article.externalId
      }
    });
  }
  const kind = validateContentKind(article.contentKind);
  if (kind !== item.contentKind) {
    throw new ExtractionError(`Source ${source.id} changed content kind while materializing ${item.externalId}.`, {
      context: { sourceId: source.id, externalId: item.externalId, discoveredKind: item.contentKind, materializedKind: kind }
    });
  }
  return {
    ...article,
    contentKind: kind,
    sourceContext: validateSourceContext(article.sourceContext)
  };
}
