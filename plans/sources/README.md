# Source expansion workstream

## Goal

Extend the application from one hard-coded Meduza feed into a small source platform that can combine heterogeneous content into one morning edition. Reddit is the first additional source, but the design should make later RSS feeds, Telegram channels, authenticated sites, or other APIs additive rather than requiring another pipeline rewrite.

The immediate user-facing target is one EPUB containing both news articles and selected Reddit discussions from a configurable set of subreddits.

## Why the foundation comes first

The current `NewsSource` contract only discovers URLs. The pipeline then applies the same Readability web extraction to every item. That works for Meduza but not for Reddit, where the useful source material is a post plus selected comments retrieved through an API.

Task 13 therefore separates:

1. source configuration,
2. discovery,
3. source-specific content materialization,
4. normalized content analysis,
5. cross-source editorial selection and rendering.

Task 14 can then implement Reddit without adding Reddit-specific branches throughout the pipeline.

## Reddit ingestion choice

The preferred implementation is Reddit's OAuth Data API. It provides structured new-post listings, stable post IDs/permalinks, engagement metadata, and comment trees. It is much better suited to a discussion digest than scraping HTML.

Other options were considered:

- **Subreddit RSS** (`/r/<name>/new/.rss`) — simple and credential-free, but useful mainly for post discovery. It does not provide the comment discussion needed for a real discussion summary and should be treated only as a fallback/debugging option.
- **Unauthenticated JSON/HTML scraping** — do not make this the supported path. It is less stable and bypasses the explicit API access model.
- **Devvit** — useful for apps installed inside Reddit communities, but it is the wrong deployment model for an external personal home-lab morning digest.

## Configuration strategy for the later admin GUI

Do not make the subreddit list an environment-only setting.

Task 13 should introduce a persistent source configuration repository in SQLite plus a service/domain layer for reading and mutating it. The first implementation may expose minimal CLI commands for bootstrap and administration, but the next admin-GUI task should call the same service rather than inventing another store.

Secrets remain outside source rows. Reddit client credentials belong in the protected deployment environment (or a future secret store); source rows contain non-secret settings such as subreddit name, enabled state, limits, and labels.

A useful conceptual model is:

```text
source configuration
├── id: stable source-instance id
├── type: meduza | reddit | ...
├── enabled
├── display name
└── settings: source-specific non-secret JSON

provider credentials
└── protected environment / future secret management
```

For Reddit, model each subreddit as a separate source instance (for example `reddit:selfhosted`) even when all instances share one OAuth client. This gives every subreddit an independent checkpoint, enabled state, limits, error status, and future GUI row.

## Edition behavior

All enabled sources participate in one scheduled run. Discovery/materialization failures are isolated per source. Successfully processed content from the remaining sources can still produce the morning edition.

Editorial selection runs once across the combined normalized content, while enforcing configurable source/source-kind limits so a high-volume Reddit feed cannot crowd all other sources out of the edition.

## Data handling principle

News articles and Reddit discussions have different retention needs. Preserve the existing full-text article behavior for ordinary news sources. For Reddit, prefer data minimization: summarize a bounded in-memory thread snapshot and avoid long-term persistence of raw comment bodies or usernames unless they are demonstrably necessary.

The normalized model must still keep enough durable identity and metadata for deduplication, checkpoints, analysis caching, attribution, and future GUI observability.

## Sequence

### Task 13 — Multi-source foundation

Make Meduza run through the generalized interfaces, introduce persistent source configuration, process multiple enabled source instances, and make the analysis/editorial/rendering domain aware of content kinds such as `article` and `discussion`.

This task must be complete and fully backward-compatible before Reddit is added.

### Task 14 — Reddit discussions

Add the Reddit OAuth client and configured subreddit instances, discover new posts, retrieve bounded discussion snapshots, summarize discussion themes/viewpoints rather than treating comments as verified facts, and mix selected discussions into the same morning EPUB.

## Admin GUI handoff

After Task 14, the expected next workstream is an admin GUI. The source work should leave these stable backend seams for it:

- list source instances and their typed settings,
- create/update/enable/disable source instances through a service layer,
- inspect source validation and last-run status,
- inspect available source types and their configuration schemas,
- never expose provider secrets through ordinary source configuration responses.

Do not implement the GUI or admin HTTP routes in Tasks 13–14 unless a small internal abstraction is required to keep the domain reusable.
