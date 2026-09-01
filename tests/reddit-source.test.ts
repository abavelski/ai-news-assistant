import assert from "node:assert/strict";
import test from "node:test";
import { parseConfig } from "../src/config.js";
import { ConfigurationError } from "../src/errors.js";
import type { RedditClient } from "../src/sources/reddit-client.js";
import {
  defaultRedditSettings,
  flattenRedditComments,
  isLikelyPrivateLlmEndpoint,
  normalizeSubredditName,
  rankRedditCandidates,
  redditRuntimeConfigIssues,
  redditSourceId,
  RedditSource,
  validateRedditSettings,
  type RedditSettings
} from "../src/sources/reddit.js";
import type { SourceConfig } from "../src/sources/config.js";
import type { DiscoveredItem } from "../src/types.js";

function redditConfig(overrides: Record<string, string> = {}) {
  return parseConfig({
    LLM_MODEL: "fixture-model",
    LLM_BASE_URL: "http://gaming-rig.home.arpa:11434",
    REDDIT_CLIENT_ID: "client",
    REDDIT_CLIENT_SECRET: "secret",
    REDDIT_USER_AGENT: "linux:ai-news-assistant:0.1 (by /u/testowner)",
    ...overrides
  });
}

function sourceConfig(subreddit = "selfhosted", overrides: Record<string, unknown> = {}): SourceConfig<RedditSettings> {
  const settings = validateRedditSettings({ ...defaultRedditSettings(subreddit), ...overrides });
  return {
    id: redditSourceId(subreddit),
    type: "reddit",
    enabled: true,
    displayName: `r/${normalizeSubredditName(subreddit)}`,
    settingsVersion: 1,
    settings,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z"
  };
}

class FakeClient {
  readonly calls: Array<{ path: string; params: Record<string, string | number | boolean | undefined> }> = [];
  constructor(private readonly handler: (path: string, params: Record<string, string | number | boolean | undefined>) => unknown) {}
  async getJson<T>(path: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
    this.calls.push({ path, params });
    return this.handler(path, params) as T;
  }
}

function post(id: string, createdUtc: number, overrides: Record<string, unknown> = {}) {
  return {
    kind: "t3",
    data: {
      id,
      name: `t3_${id}`,
      title: `Post ${id}`,
      permalink: `/r/selfhosted/comments/${id}/post_${id}/`,
      created_utc: createdUtc,
      score: 20,
      num_comments: 10,
      upvote_ratio: 0.9,
      stickied: false,
      over_18: false,
      is_self: true,
      selftext: "body",
      author: "poster",
      ...overrides
    }
  };
}

test("subreddit names normalize into stable source ids and invalid names are rejected", () => {
  assert.equal(normalizeSubredditName(" r/SelfHosted "), "selfhosted");
  assert.equal(normalizeSubredditName("https://www.reddit.com/r/LocalLLaMA/"), "localllama");
  assert.equal(redditSourceId("R/HomeLab"), "reddit:homelab");
  assert.throws(() => normalizeSubredditName("no spaces allowed"), ConfigurationError);
  assert.throws(() => normalizeSubredditName("ab"), ConfigurationError);

  const defaults = validateRedditSettings({ subreddit: "r/selfhosted" });
  assert.equal(defaults.subreddit, "selfhosted");
  assert.equal(defaults.maxDiscussionCandidates, 5);
  assert.equal(defaults.allowNsfw, false);
  assert.deepEqual(defaults.allowedFlairs, []);
  assert.throws(() => validateRedditSettings({ subreddit: "selfhosted", clientSecret: "never" }), ConfigurationError);
});

test("Reddit discovery paginates, stops at the checkpoint, filters unsafe/unwanted posts, and ranks deterministically", async () => {
  const since = new Date("2026-09-01T08:00:00.000Z");
  const pageOne = {
    data: {
      after: "page-two",
      children: [
        post("best", Date.parse("2026-09-01T10:00:00Z") / 1000, { score: 300, num_comments: 90 }),
        post("nsfw", Date.parse("2026-09-01T09:50:00Z") / 1000, { over_18: true }),
        post("sticky", Date.parse("2026-09-01T09:40:00Z") / 1000, { stickied: true }),
        post("removed", Date.parse("2026-09-01T09:30:00Z") / 1000, { selftext: "[removed]" }),
        post("quiet", Date.parse("2026-09-01T09:20:00Z") / 1000, { num_comments: 1 })
      ]
    }
  };
  const pageTwo = {
    data: {
      after: "page-three-should-not-be-requested",
      children: [
        post("second", Date.parse("2026-09-01T08:30:00Z") / 1000, { score: 50, num_comments: 20 }),
        post("old", Date.parse("2026-09-01T07:59:00Z") / 1000),
        post("older", Date.parse("2026-09-01T07:30:00Z") / 1000)
      ]
    }
  };
  const client = new FakeClient((_path, params) => params.after === "page-two" ? pageTwo : pageOne);
  const source = new RedditSource(redditConfig(), sourceConfig("selfhosted", {
    maxDiscoveredPosts: 20,
    minComments: 5,
    minScore: 5,
    maxDiscussionCandidates: 5
  }), { client: client as unknown as RedditClient });

  const discovered = await source.discover(since);
  assert.deepEqual(discovered.map((entry) => entry.externalId), ["t3_best", "t3_second"]);
  assert.equal(client.calls.length, 2);
  assert.ok(discovered.every((entry) => entry.contentKind === "discussion"));
  assert.ok(discovered.every((entry) => entry.context.subreddit === "selfhosted"));
  assert.ok(discovered.every((entry) => !("postAuthor" in entry.context)));

  const tied: DiscoveredItem[] = [
    { sourceId: "reddit:x", externalId: "b", url: "https://reddit.test/b", title: "b", publishedAt: "2026-09-01T10:00:00Z", contentKind: "discussion", context: { score: 5, commentCount: 5, upvoteRatio: 0.9 } },
    { sourceId: "reddit:x", externalId: "a", url: "https://reddit.test/a", title: "a", publishedAt: "2026-09-01T10:00:00Z", contentKind: "discussion", context: { score: 5, commentCount: 5, upvoteRatio: 0.9 } }
  ];
  assert.deepEqual(rankRedditCandidates(tied, Date.parse("2026-09-01T11:00:00Z")).map((entry) => entry.externalId), ["a", "b"]);
});

test("comment flattening applies depth/count/character limits and excludes deleted, removed, duplicate, and AutoModerator comments", () => {
  const settings = { ...defaultRedditSettings("selfhosted"), maxComments: 3, maxCommentDepth: 2, maxCommentChars: 100, maxDiscussionChars: 220 };
  const listing = {
    data: {
      children: [
        { kind: "more", data: { id: "more" } },
        { kind: "t1", data: { id: "deleted", author: "x", body: "[deleted]" } },
        { kind: "t1", data: { id: "auto", author: "AutoModerator", body: "boilerplate" } },
        { kind: "t1", data: { id: "one", author: "alice", body: "First useful viewpoint", replies: { data: { children: [
          { kind: "t1", data: { id: "two", author: "bob", body: "Nested useful viewpoint", replies: { data: { children: [
            { kind: "t1", data: { id: "three", author: "carol", body: "Too deep" } }
          ] } } } }
        ] } } } },
        { kind: "t1", data: { id: "one", author: "alice", body: "duplicate id" } },
        { kind: "t1", data: { id: "four", author: "dave", body: "Final useful viewpoint" } }
      ]
    }
  };

  const flattened = flattenRedditComments(listing, settings);
  assert.deepEqual(flattened.comments, ["First useful viewpoint", "Nested useful viewpoint", "Final useful viewpoint"]);
  assert.ok(flattened.aggregateCharacters <= settings.maxDiscussionChars);
  assert.doesNotMatch(flattened.comments.join(" "), /alice|bob|carol|AutoModerator|deleted|Too deep/);
});

test("materialized Reddit discussion contains bounded anonymous comments while durable content discards them", async () => {
  const client = new FakeClient(() => [
    { data: { children: [{ kind: "t3", data: { selftext: "The original post body" } }] } },
    { data: { children: [
      { kind: "t1", data: { id: "c1", author: "alice", body: "A useful comment" } },
      { kind: "t1", data: { id: "c2", author: "bob", body: "Another viewpoint" } }
    ] } }
  ]);
  const source = new RedditSource(redditConfig(), sourceConfig(), { client: client as unknown as RedditClient });
  const item: DiscoveredItem = {
    sourceId: "reddit:selfhosted",
    externalId: "t3_abc",
    url: "https://www.reddit.com/r/selfhosted/comments/abc/example/",
    title: "Example discussion",
    publishedAt: "2026-09-01T10:00:00.000Z",
    contentKind: "discussion",
    context: { subreddit: "selfhosted", redditPostId: "abc", score: 12, commentCount: 2, outboundUrl: "https://example.test" }
  };

  const materialized = await source.materialize(item);
  assert.match(materialized.text, /The original post body/);
  assert.match(materialized.text, /A useful comment/);
  assert.match(materialized.text, /Another viewpoint/);
  assert.doesNotMatch(materialized.text, /alice|bob/);
  assert.equal(materialized.sourceContext.sampledCommentCount, 2);

  const durable = source.prepareForPersistence(materialized);
  assert.equal(durable.text, "[Reddit discussion snapshot discarded after analysis]");
  assert.equal(durable.contentHtml, "");
  assert.equal(durable.contentHash, materialized.contentHash);
});

test("Reddit requires an explicit acknowledgement for external LLM processing but accepts LAN/private endpoints", () => {
  assert.equal(isLikelyPrivateLlmEndpoint("http://192.168.1.50:11434"), true);
  assert.equal(isLikelyPrivateLlmEndpoint("http://gaming-rig.home.arpa:11434"), true);
  assert.equal(isLikelyPrivateLlmEndpoint("https://api.openai.com"), false);
  const external = redditConfig({ LLM_BASE_URL: "https://api.openai.com" });
  assert.match(redditRuntimeConfigIssues(external).join(" "), /external-acknowledged/);
  const acknowledged = redditConfig({ LLM_BASE_URL: "https://api.openai.com", REDDIT_LLM_TRUST_BOUNDARY: "external-acknowledged" });
  assert.deepEqual(redditRuntimeConfigIssues(acknowledged), []);
});