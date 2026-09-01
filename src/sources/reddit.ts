import type { AppConfig } from "../config.js";
import { ConfigurationError, ExtractionError } from "../errors.js";
import type { FetchFunction, SleepFunction } from "../http.js";
import type { Article, DiscoveredItem, SourceContext } from "../types.js";
import { sha256 } from "../utils/hash.js";
import type { SourceConfig } from "./config.js";
import { validateNonSecretSettings } from "./config.js";
import { RedditClient, type RedditClientDependencies } from "./reddit-client.js";
import type { SourceAdapter } from "./source.js";

export const REDDIT_SOURCE_TYPE = "reddit";
export const REDDIT_SETTINGS_VERSION = 1;

export interface RedditSettings extends Record<string, unknown> {
  subreddit: string;
  maxDiscoveredPosts: number;
  minComments: number;
  minScore: number;
  maxDiscussionCandidates: number;
  allowNsfw: boolean;
  allowedFlairs: string[];
  excludedFlairs: string[];
  maxComments: number;
  maxCommentDepth: number;
  maxCommentChars: number;
  maxDiscussionChars: number;
}

interface RedditSettingDefaults {
  maxDiscoveredPosts: number;
  minComments: number;
  minScore: number;
  maxDiscussionCandidates: number;
  allowNsfw: boolean;
  allowedFlairs: string[];
  excludedFlairs: string[];
  maxComments: number;
  maxCommentDepth: number;
  maxCommentChars: number;
  maxDiscussionChars: number;
}

export class RedditCandidateBudget {
  private remaining: number;
  constructor(readonly limit: number) {
    this.remaining = limit;
  }
  take(items: DiscoveredItem[]): DiscoveredItem[] {
    if (this.remaining <= 0) return [];
    const selected = items.slice(0, this.remaining);
    this.remaining -= selected.length;
    return selected;
  }
}

export interface RedditSourceDependencies extends RedditClientDependencies {
  client?: RedditClient;
  budget?: RedditCandidateBudget;
  fetchFn?: FetchFunction;
  sleep?: SleepFunction;
}

interface RedditListingChild {
  kind?: unknown;
  data?: Record<string, unknown>;
}

interface RedditListing {
  data?: {
    after?: unknown;
    children?: RedditListingChild[];
  };
}

interface RedditThreadListing {
  data?: {
    children?: RedditListingChild[];
  };
}

const SUBREDDIT_PATTERN = /^[A-Za-z0-9_]{3,21}$/;
const DEFAULTS: RedditSettingDefaults = {
  maxDiscoveredPosts: 50,
  minComments: 5,
  minScore: 5,
  maxDiscussionCandidates: 5,
  allowNsfw: false,
  allowedFlairs: [],
  excludedFlairs: [],
  maxComments: 30,
  maxCommentDepth: 3,
  maxCommentChars: 1_500,
  maxDiscussionChars: 18_000
};
const SETTINGS_KEYS = new Set(["subreddit", ...Object.keys(DEFAULTS)]);

function integerSetting(value: unknown, name: string, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) {
    throw new ConfigurationError(`Reddit ${name} must be an integer between ${min} and ${max}.`);
  }
  return Number(value);
}

function booleanSetting(value: unknown, name: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new ConfigurationError(`Reddit ${name} must be a boolean.`);
  return value;
}

function stringListSetting(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50) {
    throw new ConfigurationError(`Reddit ${name} must be an array containing at most 50 strings.`);
  }
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !entry.trim() || entry.trim().length > 100) {
      throw new ConfigurationError(`Reddit ${name} must contain only non-empty strings up to 100 characters.`);
    }
    result.push(entry.trim().toLocaleLowerCase("und"));
  }
  return [...new Set(result)].sort();
}

export function normalizeSubredditName(value: string): string {
  let normalized = value.trim();
  try {
    if (/^https?:\/\//i.test(normalized)) {
      const url = new URL(normalized);
      const match = url.pathname.match(/^\/r\/([^/]+)/i);
      if (!match?.[1]) throw new Error("missing subreddit");
      normalized = match[1];
    }
  } catch {
    throw new ConfigurationError(`Invalid subreddit ${JSON.stringify(value)}.`);
  }
  normalized = normalized.replace(/^\/?r\//i, "").replace(/^\/+|\/+$/g, "");
  if (!SUBREDDIT_PATTERN.test(normalized)) {
    throw new ConfigurationError(
      "Subreddit names must contain 3-21 letters, digits, or underscores (the optional r/ prefix is accepted)."
    );
  }
  return normalized.toLocaleLowerCase("en-US");
}

export function redditSourceId(subreddit: string): string {
  return `reddit:${normalizeSubredditName(subreddit)}`;
}

export function defaultRedditSettings(subreddit: string): RedditSettings {
  return { subreddit: normalizeSubredditName(subreddit), ...DEFAULTS };
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10 || parts[0] === 127 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && (parts[1] ?? 0) >= 16 && (parts[1] ?? 0) <= 31) ||
    (parts[0] === 192 && parts[1] === 168);
}

export function isLikelyPrivateLlmEndpoint(baseUrl: string): boolean {
  const hostname = new URL(baseUrl).hostname.toLocaleLowerCase("en-US").replace(/^\[|\]$/g, "");
  if (!hostname.includes(".") && !hostname.includes(":")) return true;
  if (hostname === "localhost" || hostname === "host.docker.internal") return true;
  if (hostname.endsWith(".local") || hostname.endsWith(".home.arpa")) return true;
  if (isPrivateIpv4(hostname)) return true;
  return hostname === "::1" || hostname.startsWith("fc") || hostname.startsWith("fd") || hostname.startsWith("fe80:");
}

export function redditMissingRuntimeSecrets(config: AppConfig): string[] {
  return [
    !config.redditClientId ? "REDDIT_CLIENT_ID" : undefined,
    !config.redditClientSecret ? "REDDIT_CLIENT_SECRET" : undefined
  ].filter((value): value is string => Boolean(value));
}

export function redditRuntimeConfigIssues(config: AppConfig): string[] {
  const issues: string[] = [];
  if (!/^[-A-Za-z0-9_.]+:[-A-Za-z0-9_.]+:[^\s()]+ \(by \/u\/[A-Za-z0-9_-]+\)$/.test(config.redditUserAgent)) {
    issues.push("REDDIT_USER_AGENT must be descriptive, for example linux:ai-news-assistant:0.1 (by /u/yourname).");
  }
  if (!isLikelyPrivateLlmEndpoint(config.llmBaseUrl) && config.redditLlmTrustBoundary !== "external-acknowledged") {
    issues.push(
      "LLM_BASE_URL appears external. Set REDDIT_LLM_TRUST_BOUNDARY=external-acknowledged only after reviewing current Reddit terms and deliberately accepting that processing boundary."
    );
  }
  return issues;
}

export function validateRedditSettings(value: unknown, settingsVersion = REDDIT_SETTINGS_VERSION): RedditSettings {
  if (settingsVersion !== REDDIT_SETTINGS_VERSION) {
    throw new ConfigurationError(
      `Reddit settings version ${settingsVersion} is not supported; expected ${REDDIT_SETTINGS_VERSION}.`
    );
  }
  const settings = validateNonSecretSettings(value);
  for (const key of Object.keys(settings)) {
    if (!SETTINGS_KEYS.has(key)) throw new ConfigurationError(`Unexpected Reddit source setting ${JSON.stringify(key)}.`);
  }
  if (typeof settings.subreddit !== "string") throw new ConfigurationError("Reddit subreddit is required.");
  const result: RedditSettings = {
    subreddit: normalizeSubredditName(settings.subreddit),
    maxDiscoveredPosts: integerSetting(settings.maxDiscoveredPosts, "maxDiscoveredPosts", DEFAULTS.maxDiscoveredPosts, 1, 500),
    minComments: integerSetting(settings.minComments, "minComments", DEFAULTS.minComments, 0, 1_000_000),
    minScore: integerSetting(settings.minScore, "minScore", DEFAULTS.minScore, 0, 10_000_000),
    maxDiscussionCandidates: integerSetting(settings.maxDiscussionCandidates, "maxDiscussionCandidates", DEFAULTS.maxDiscussionCandidates, 1, 50),
    allowNsfw: booleanSetting(settings.allowNsfw, "allowNsfw", DEFAULTS.allowNsfw),
    allowedFlairs: stringListSetting(settings.allowedFlairs, "allowedFlairs"),
    excludedFlairs: stringListSetting(settings.excludedFlairs, "excludedFlairs"),
    maxComments: integerSetting(settings.maxComments, "maxComments", DEFAULTS.maxComments, 1, 200),
    maxCommentDepth: integerSetting(settings.maxCommentDepth, "maxCommentDepth", DEFAULTS.maxCommentDepth, 1, 10),
    maxCommentChars: integerSetting(settings.maxCommentChars, "maxCommentChars", DEFAULTS.maxCommentChars, 100, 5_000),
    maxDiscussionChars: integerSetting(settings.maxDiscussionChars, "maxDiscussionChars", DEFAULTS.maxDiscussionChars, 1_000, 50_000)
  };
  if (result.maxDiscussionCandidates > result.maxDiscoveredPosts) {
    throw new ConfigurationError("Reddit maxDiscussionCandidates must not exceed maxDiscoveredPosts.");
  }
  return result;
}

function absolutePermalink(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith("/")) return undefined;
  return new URL(value, "https://www.reddit.com").toString();
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizedFlair(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().toLocaleLowerCase("und") : undefined;
}

function isRemovedPost(data: Record<string, unknown>): boolean {
  return Boolean(data.removed_by_category) || data.selftext === "[removed]" || data.selftext === "[deleted]" || data.author === "[deleted]";
}

function candidateRank(score: number, comments: number, upvoteRatio: number, ageHours: number): number {
  return Math.log2(comments + 1) * 5 + Math.log2(Math.max(0, score) + 1) * 2 +
    Math.max(0, Math.min(1, upvoteRatio)) * 2 - Math.min(48, Math.max(0, ageHours)) * 0.08;
}

export function rankRedditCandidates(items: DiscoveredItem[], nowMs = Date.now()): DiscoveredItem[] {
  return [...items].sort((left, right) => {
    const leftScore = Number(left.context.score ?? 0);
    const rightScore = Number(right.context.score ?? 0);
    const leftComments = Number(left.context.commentCount ?? 0);
    const rightComments = Number(right.context.commentCount ?? 0);
    const leftRatio = Number(left.context.upvoteRatio ?? 0);
    const rightRatio = Number(right.context.upvoteRatio ?? 0);
    const leftAge = Math.max(0, nowMs - new Date(left.publishedAt).getTime()) / 3_600_000;
    const rightAge = Math.max(0, nowMs - new Date(right.publishedAt).getTime()) / 3_600_000;
    const difference = candidateRank(rightScore, rightComments, rightRatio, rightAge) -
      candidateRank(leftScore, leftComments, leftRatio, leftAge);
    if (difference !== 0) return difference;
    const published = new Date(right.publishedAt).getTime() - new Date(left.publishedAt).getTime();
    if (published !== 0) return published;
    return left.externalId.localeCompare(right.externalId);
  });
}

function truncateUnicode(value: string, maxCharacters: number): string {
  return Array.from(value).slice(0, maxCharacters).join("");
}

export function flattenRedditComments(
  listing: RedditThreadListing | undefined,
  settings: RedditSettings
): { comments: string[]; aggregateCharacters: number } {
  const output: string[] = [];
  const seen = new Set<string>();
  let aggregateCharacters = 0;

  const visit = (children: RedditListingChild[] | undefined, depth: number): void => {
    if (!children || depth > settings.maxCommentDepth || output.length >= settings.maxComments) return;
    for (const child of children) {
      if (output.length >= settings.maxComments || aggregateCharacters >= settings.maxDiscussionChars) break;
      if (child.kind !== "t1" || !child.data) continue;
      const data = child.data;
      const id = typeof data.id === "string" ? data.id : undefined;
      const body = typeof data.body === "string" ? data.body.trim() : "";
      const author = typeof data.author === "string" ? data.author : "";
      if (!id || seen.has(id) || !body || body === "[deleted]" || body === "[removed]" || author === "AutoModerator") continue;
      seen.add(id);
      let clipped = truncateUnicode(body, settings.maxCommentChars).trim();
      const remaining = settings.maxDiscussionChars - aggregateCharacters;
      if (remaining <= 0) break;
      clipped = truncateUnicode(clipped, remaining);
      if (clipped) {
        output.push(clipped);
        aggregateCharacters += Array.from(clipped).length;
      }
      const replies = data.replies;
      if (replies && typeof replies === "object" && !Array.isArray(replies)) {
        visit((replies as RedditThreadListing).data?.children, depth + 1);
      }
    }
  };

  visit(listing?.data?.children, 1);
  return { comments: output, aggregateCharacters };
}

function postContext(data: Record<string, unknown>, subreddit: string): SourceContext {
  const permalink = absolutePermalink(data.permalink);
  const outbound = typeof data.url === "string" && !data.url.includes("reddit.com/") ? data.url : undefined;
  return {
    subreddit,
    redditPostId: typeof data.id === "string" ? data.id : "",
    redditFullname: typeof data.name === "string" ? data.name : "",
    permalink: permalink ?? "",
    score: finiteNumber(data.score) ?? 0,
    commentCount: finiteNumber(data.num_comments) ?? 0,
    upvoteRatio: finiteNumber(data.upvote_ratio) ?? 0,
    flair: typeof data.link_flair_text === "string" ? data.link_flair_text : "",
    isSelf: Boolean(data.is_self),
    nsfw: Boolean(data.over_18),
    outboundUrl: outbound ?? ""
  };
}

export class RedditSource implements SourceAdapter {
  readonly id: string;
  readonly type = REDDIT_SOURCE_TYPE;
  readonly settings: RedditSettings;
  private readonly client: RedditClient;
  private readonly budget?: RedditCandidateBudget;

  constructor(private readonly appConfig: AppConfig, sourceConfig: SourceConfig<RedditSettings>, dependencies: RedditSourceDependencies = {}) {
    this.id = sourceConfig.id;
    this.settings = validateRedditSettings(sourceConfig.settings, sourceConfig.settingsVersion);
    if (this.id !== redditSourceId(this.settings.subreddit)) {
      throw new ConfigurationError(
        `Reddit source id must be ${redditSourceId(this.settings.subreddit)} for subreddit r/${this.settings.subreddit}.`
      );
    }
    this.budget = dependencies.budget;
    this.client = dependencies.client ?? new RedditClient({
      clientId: appConfig.redditClientId ?? "",
      clientSecret: appConfig.redditClientSecret ?? "",
      userAgent: appConfig.redditUserAgent,
      timeoutMs: appConfig.redditHttpTimeoutMs,
      retries: appConfig.redditHttpRetries,
      retryBaseDelayMs: appConfig.redditRetryBaseDelayMs,
      maxResponseBytes: appConfig.redditMaxResponseBytes,
      maxRateLimitWaitMs: appConfig.redditMaxRateLimitWaitMs
    }, dependencies);
  }

  async discover(since: Date): Promise<DiscoveredItem[]> {
    const collected: DiscoveredItem[] = [];
    let after: string | undefined;
    let inspected = 0;
    let reachedCutoff = false;

    while (inspected < this.settings.maxDiscoveredPosts && !reachedCutoff) {
      const limit = Math.min(100, this.settings.maxDiscoveredPosts - inspected);
      const listing = await this.client.getJson<RedditListing>(`/r/${this.settings.subreddit}/new`, { limit, after, raw_json: 1 });
      const children = listing.data?.children ?? [];
      if (!children.length) break;

      for (const child of children) {
        inspected += 1;
        if (inspected > this.settings.maxDiscoveredPosts) break;
        if (child.kind !== "t3" || !child.data) continue;
        const data = child.data;
        const createdUtc = finiteNumber(data.created_utc);
        const postId = typeof data.id === "string" ? data.id : undefined;
        const title = typeof data.title === "string" ? data.title.trim() : "";
        const permalink = absolutePermalink(data.permalink);
        if (!createdUtc || !postId || !title || !permalink) continue;
        const publishedAt = new Date(createdUtc * 1_000);
        if (publishedAt < since) {
          reachedCutoff = true;
          continue;
        }
        if (Boolean(data.stickied) || isRemovedPost(data)) continue;
        if (!this.settings.allowNsfw && Boolean(data.over_18)) continue;

        const commentCount = finiteNumber(data.num_comments) ?? 0;
        const score = finiteNumber(data.score) ?? 0;
        if (commentCount < this.settings.minComments || score < this.settings.minScore) continue;

        const flair = normalizedFlair(data.link_flair_text);
        if (this.settings.allowedFlairs.length && (!flair || !this.settings.allowedFlairs.includes(flair))) continue;
        if (flair && this.settings.excludedFlairs.includes(flair)) continue;

        collected.push({
          sourceId: this.id,
          externalId: `t3_${postId}`,
          url: permalink,
          title,
          publishedAt: publishedAt.toISOString(),
          contentKind: "discussion",
          context: postContext(data, this.settings.subreddit)
        });
      }

      const next = listing.data?.after;
      after = typeof next === "string" && next ? next : undefined;
      if (!after) break;
    }

    const ranked = rankRedditCandidates(collected).slice(0, this.settings.maxDiscussionCandidates);
    return this.budget ? this.budget.take(ranked) : ranked;
  }

  async materialize(item: DiscoveredItem): Promise<Article> {
    const postId = typeof item.context.redditPostId === "string" ? item.context.redditPostId : "";
    if (!postId) throw new ExtractionError(`Reddit item ${item.externalId} has no post id.`);

    const thread = await this.client.getJson<unknown[]>(`/comments/${postId}`, {
      sort: "top",
      depth: this.settings.maxCommentDepth,
      limit: this.settings.maxComments,
      raw_json: 1
    });
    if (!Array.isArray(thread) || thread.length < 2) {
      throw new ExtractionError(`Reddit thread ${postId} returned an unexpected response shape.`);
    }

    const postListing = thread[0] as RedditThreadListing;
    const commentsListing = thread[1] as RedditThreadListing;
    const postData = postListing.data?.children?.find((child) => child.kind === "t3")?.data;
    const selfText = postData && typeof postData.selftext === "string" && postData.selftext !== "[removed]" && postData.selftext !== "[deleted]"
      ? postData.selftext.trim() : "";
    const { comments } = flattenRedditComments(commentsListing, this.settings);

    const parts = [`Post: ${item.title}`];
    if (selfText) {
      const maxPostChars = Math.min(6_000, Math.floor(this.settings.maxDiscussionChars / 3));
      parts.push(`Post body:\n${truncateUnicode(selfText, maxPostChars)}`);
    }
    if (comments.length) {
      parts.push(
        `Sampled top comments (${comments.length}; usernames intentionally omitted):\n` +
        comments.map((body, index) => `Comment ${index + 1}:\n${body}`).join("\n\n")
      );
    } else {
      parts.push("No eligible comments were available in the bounded discussion snapshot.");
    }

    const text = truncateUnicode(parts.join("\n\n"), this.settings.maxDiscussionChars);
    return {
      sourceId: this.id,
      externalId: item.externalId,
      url: item.url,
      title: item.title,
      publishedAt: item.publishedAt,
      language: this.appConfig.editionLanguage,
      contentKind: "discussion",
      sourceContext: { ...item.context, sampledCommentCount: comments.length },
      text,
      contentHtml: "",
      contentHash: sha256(text),
      fetchedAt: new Date().toISOString()
    };
  }

  prepareForPersistence(content: Article): Article {
    return {
      ...content,
      text: "[Reddit discussion snapshot discarded after analysis]",
      contentHtml: ""
    };
  }
}
