# Task 14 — Reddit discussion source with configurable subreddits

## Goal

Add Reddit as the first non-article source on top of Task 13. A user should be able to configure a set of subreddits, ingest new discussions from each one every morning, summarize the substance of the discussion (not merely the linked post), and mix selected Reddit discussions into the same EPUB as Meduza/news content.

The implementation should be conservative with API usage, LLM cost, raw Reddit data retention, and source balance.

## Prerequisite

Complete Task 13 first. Reddit must use the generic source configuration, adapter/materialization, source-run status, content-kind, and multi-source orchestration contracts rather than adding a second pipeline.

## Supported access method

Use Reddit's OAuth Data API as the primary supported path.

Reasons:

- structured `/new` listings support time-bounded discovery and pagination;
- stable Reddit post IDs/permalinks make deduplication reliable;
- thread/comment endpoints provide the discussion content needed for summarization;
- engagement metadata can be used for bounded candidate selection;
- authenticated access provides an explicit rate-limit/identity model.

Do not make HTML scraping or unauthenticated `.json` access the production implementation.

Subreddit RSS may be documented as a discovery-only fallback/debugging option, but it is not sufficient for discussion summaries because it does not provide the comment thread.

Devvit is out of scope: the application remains an external self-hosted service, not an app installed into subreddits.

## Required changes

### 1. Add Reddit provider credentials without storing secrets in source rows

Add protected environment settings for the Reddit OAuth client, with strict validation and redacted diagnostics. Prefer an application-only/read-only OAuth flow when current Reddit API access permits the configured use case; do not request write scopes.

Expected conceptual settings:

```dotenv
REDDIT_CLIENT_ID=...
REDDIT_CLIENT_SECRET=...
REDDIT_USER_AGENT="linux:ai-news-assistant:<version> (by /u/<owner>)"
```

If current registration/authentication rules require additional account fields for the chosen personal-script flow, add only the minimum required fields and document why.

Never log secrets, access tokens, Authorization headers, or full OAuth responses.

Token acquisition/refresh belongs in a dedicated Reddit client, not in source adapters.

### 2. Register the Reddit source type and subreddit settings schema

Add a `reddit` source type to the Task 13 source registry.

Represent each configured subreddit as an independent source instance, for example:

```text
reddit:selfhosted
reddit:homelab
reddit:localllama
```

Validate subreddit names strictly and normalize accepted inputs such as `r/selfhosted` to `selfhosted` before generating the stable source ID.

Reddit source settings should be non-secret and GUI-friendly. Include sensible defaults for at least:

- `subreddit`,
- enabled state (generic source field),
- maximum discovered posts per run,
- minimum comment count and/or minimum engagement threshold,
- maximum discussion candidates materialized per run,
- whether NSFW posts are allowed (default false),
- optional allowed/excluded flair filters.

Global defaults may live in application config, but persisted source settings should be explicit enough for a later GUI to display/edit without parsing an opaque string.

### 3. Extend the source CLI for subreddit configuration

Before the admin GUI exists, support a convenient CLI flow equivalent to:

```text
sources add reddit selfhosted
sources add reddit homelab
sources list
sources disable reddit:homelab
```

Reject duplicate normalized subreddit instances cleanly.

Document that the later admin GUI will use the same source configuration service.

### 4. Implement a bounded Reddit OAuth HTTP client

Create a dedicated client with:

- OAuth token acquisition/caching,
- the configured descriptive User-Agent,
- request timeout,
- retry/backoff for transient failures,
- explicit handling for 401/403/404/429/5xx,
- pagination helpers for Reddit listings,
- parsing/monitoring of Reddit rate-limit response headers when present,
- bounded response bodies and safe diagnostics.

Do not reuse generic web scraping assumptions for Reddit API responses.

The client must never exceed server-provided rate-limit guidance. If the remaining quota becomes low, slow down or stop cleanly rather than hammering the endpoint.

### 5. Discover new posts independently per subreddit

For each configured subreddit, discover posts from the `new` listing using that source instance's checkpoint/lookback.

Discovery should capture only bounded metadata needed to choose candidates, such as:

- Reddit post/fullname ID,
- title,
- permalink,
- created timestamp,
- score,
- number of comments,
- upvote ratio when available,
- flair,
- self-post/link indicator,
- NSFW/stickied/removed state needed for filtering.

Skip at minimum:

- posts older than the source's effective `since`,
- stickied/mod announcement posts unless explicitly configured later,
- removed/deleted posts,
- NSFW posts by default,
- duplicate post IDs already known.

Stop pagination once the listing has clearly moved older than `since` or configured page/candidate limits are reached.

### 6. Pre-rank candidates before fetching comment trees

Do not fetch a full comment tree for every new post across every subreddit.

Use a deterministic, documented engagement/freshness ranking to select a bounded number of discussion candidates per subreddit. The ranking can use fields such as comment count, score, and age, but it must be deterministic and testable.

Keep configurable hard limits so a user following many busy subreddits cannot accidentally cause hundreds of thread fetches or LLM calls in one morning.

Do not make this pre-ranking the final editorial selection; it is only an ingestion-cost guardrail.

### 7. Materialize a bounded discussion snapshot

For each selected Reddit candidate, fetch the post and a bounded comment snapshot from the thread endpoint.

Prefer top/relevant comments rather than attempting to reconstruct the entire tree. Define explicit limits for:

- maximum comments,
- maximum nesting depth,
- maximum characters per comment,
- maximum aggregate discussion characters,
- handling of `more` placeholders.

Exclude or clearly ignore:

- `[deleted]`/`[removed]` bodies,
- AutoModerator boilerplate by default,
- empty comments,
- duplicate comment IDs,
- usernames from the LLM payload unless attribution is genuinely needed.

Preserve enough structural separation so the LLM can tell comments apart. Do not concatenate an unbounded raw JSON tree.

For link posts, the Reddit discussion summary should primarily reflect the Reddit conversation. Fetching/extracting the linked external article is not required in this task; the original Reddit permalink and outbound URL may be retained as metadata.

### 8. Use a discussion-specific analysis prompt/schema behavior

Set Reddit materialized content to `contentKind: "discussion"`.

The discussion prompt must explicitly ask for:

- a concise description of what the thread is about,
- the main viewpoints/themes in the comments,
- areas of agreement and disagreement,
- notable practical advice or references when present,
- uncertainty/caveats,
- neutral `keyPoints` rather than "facts" derived from commenters.

It must explicitly tell the model not to present Reddit comments as verified facts and not to infer consensus merely from a few sampled comments.

Reuse the generic analysis fields from Task 13 where possible (`summary`, `topics`, `importance`, `recommended`, `reason`, `keyPoints`) and use a versioned discussion prompt rather than creating an unrelated result model.

### 9. Minimize persisted raw Reddit content

Default to data minimization.

Do not persist raw comment bodies or commenter usernames long-term merely to support the digest. Prefer this flow:

```text
API thread snapshot
→ bounded in-memory materialized discussion
→ content hash + LLM analysis
→ persist durable post identity/metadata + analysis
→ discard raw comments
```

Persist only what is necessary for:

- deduplication,
- checkpointing,
- attribution/linking,
- analysis caching/identity,
- rendering,
- operational debugging without raw provider payloads.

If the current normalized storage layer requires a `text` field, Task 13 should provide a source-specific retention mechanism rather than forcing Reddit comments into permanent article storage.

Do not store OAuth responses or access tokens in SQLite.

### 10. Treat Reddit/API terms and third-party processing conservatively

Document the current Reddit API/Developer requirements as an operational dependency and expect them to change.

The implementation must:

- use authenticated/registered API access,
- use an honest descriptive User-Agent,
- respect API limits,
- avoid retaining data beyond the digest use case,
- make deletion/minimal-retention behavior technically possible,
- avoid training/fine-tuning models on Reddit content.

Because Reddit's current developer terms restrict sharing/retaining Reddit Services and Data, do not silently assume that forwarding raw Reddit content to an arbitrary cloud LLM is acceptable. The supported/default personal deployment should use the local OpenAI-compatible LLM on the trusted gaming rig.

Add an explicit configuration/trust-boundary guard or documented operator acknowledgement before Reddit content can be sent to a non-local/third-party LLM endpoint. Do not attempt to infer legal permission solely from a hostname.

This is an engineering safeguard, not legal advice; the README should direct operators to re-check current Reddit terms before enabling external processing.

### 11. Mix Reddit into editorial selection without flooding the edition

Pass Reddit analyses into the same cross-source editorial selection as Meduza.

Include source context in the editorial candidate metadata, especially:

- source type `reddit`,
- subreddit label,
- engagement snapshot,
- discussion content kind.

Apply the Task 13 source/source-kind caps consistently in both LLM selection and deterministic fallback.

A reasonable default should ensure the morning edition contains a useful Reddit section without allowing dozens of subreddit candidates to displace all news articles. Exact defaults should be documented and configurable.

### 12. Render discussions as discussions

Add content-kind-aware EPUB presentation for selected Reddit entries.

At minimum show:

- `r/<subreddit>` attribution,
- post title,
- post age/publication time,
- comment-count/score snapshot when available,
- discussion summary,
- discussion takeaways/key points,
- original Reddit permalink,
- outbound link when the post is a link post.

Do not render raw sampled comment bodies by default. `INCLUDE_FULL_ARTICLES` should not cause raw Reddit comment snapshots to be embedded.

The EPUB should remain deterministic for the persisted normalized inputs.

### 13. Source health and doctor behavior

Extend `doctor`/source status so Reddit configuration failures are actionable:

- missing OAuth client configuration,
- invalid subreddit source settings,
- authentication failure,
- forbidden/private/banned/nonexistent subreddit,
- rate limiting,
- local-LLM trust-boundary mismatch.

Do not require Reddit credentials when there are no enabled Reddit source instances.

A failure in one subreddit should be visible in per-source status while other subreddits/news sources continue.

### 14. Documentation

Update README and `.env.example` with:

- Reddit app/API registration prerequisites,
- required OAuth environment variables,
- source CLI examples for adding/removing/disabling subreddits,
- local-LLM recommendation/data-boundary warning,
- default filtering/candidate/comment limits,
- how Reddit discussions appear in the edition,
- rate-limit expectations,
- what Reddit data is and is not persisted,
- troubleshooting private/banned/invalid subreddits.

Do not claim Reddit RSS or scraping is the supported primary implementation.

## Tests and validation

Use fixtures/mocked HTTP; automated tests must not depend on live Reddit or a paid LLM.

Add tests for at least:

1. subreddit name normalization/validation;
2. Reddit source config creation/duplicate rejection;
3. OAuth token request construction and secret redaction;
4. descriptive User-Agent use;
5. `/new` listing parsing/pagination/cutoff at checkpoint;
6. removed/stickied/NSFW filtering;
7. deterministic engagement/freshness candidate ranking;
8. rate-limit header handling and 429 behavior;
9. comment-tree flattening with limits/depth/character caps;
10. deleted/removed/AutoModerator comment filtering;
11. no raw usernames/comments persisted after successful analysis;
12. discussion prompt/schema validation and analysis versioning;
13. source checkpoint behavior for Reddit partial failures;
14. mixed Meduza + multiple-subreddit edition selection;
15. deterministic source caps in fallback selection;
16. Reddit EPUB attribution/link rendering without raw comments;
17. Reddit disabled/no-credentials configuration still allowing Meduza-only runs;
18. doctor errors for missing credentials/invalid source;
19. trust-boundary safeguard for external LLM processing;
20. regression coverage for existing Meduza behavior.

Run the full suite and Docker smoke tests.

Where current Reddit API semantics are material (OAuth scopes, endpoint behavior, rate-limit headers), verify them against current official documentation during implementation rather than relying on stale examples.

## Acceptance criteria

- A user can configure multiple subreddit source instances without editing code.
- Reddit uses authenticated OAuth API access with a descriptive User-Agent.
- Each subreddit has an independent checkpoint/status/enabled state.
- New posts are discovered with bounded pagination and filtering.
- Only bounded high-value candidates have comment trees materialized.
- Discussion summaries reflect post + comments and clearly distinguish viewpoints from facts.
- Raw Reddit comments/usernames are not retained long-term by default.
- Reddit content is not silently forwarded to an arbitrary third-party/cloud LLM.
- API limits and transient failures are handled without blocking other sources.
- Reddit and Meduza content can appear in one edition with deterministic source-balance constraints.
- The EPUB identifies subreddit discussions clearly and links to the original thread.
- Meduza-only deployments continue to work with no Reddit credentials.
- The source configuration/status service is ready for the next admin-GUI task.
- Full tests and container smoke validation pass without live Reddit/paid LLM calls.

## Admin GUI compatibility requirements

The later GUI should be able to:

- list Reddit subreddit instances alongside Meduza,
- add a subreddit from a simple name field,
- edit limits/filters,
- enable/disable a subreddit,
- show validation/last-run status and recent failure reason,
- indicate whether Reddit credentials are configured without exposing them,
- indicate the local/external LLM data-boundary policy.

Keep these capabilities in source/provider services and typed schemas, not inside CLI-only code.

## Non-goals

Do not:

- implement the admin GUI yet,
- import the user's Reddit subscriptions automatically yet,
- vote/comment/save/submit anything on Reddit,
- ingest private messages or user profile history,
- scrape Reddit HTML as the primary path,
- use Devvit,
- archive complete comment trees,
- train/fine-tune an AI model on Reddit content,
- fetch the full external article for every link post,
- implement Wake-on-LAN for the gaming rig.

A later enhancement may add "import my subscribed subreddits" once the admin GUI and user-auth flow exist; the persisted source model should make that an additive feature.

## Suggested commit

```text
feat: add configurable Reddit discussion source
```
