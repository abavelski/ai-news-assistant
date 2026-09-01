# Task 13 — Multi-source pipeline and GUI-ready source configuration

## Goal

Generalize the current single-source Meduza pipeline into a multi-source system that can process heterogeneous source types in one morning run and one EPUB, without changing the existing Meduza behavior.

This task is the architectural prerequisite for Reddit and for the later admin GUI. It should create stable source configuration and orchestration boundaries that both can reuse.

## Current constraints to remove

Today:

- the CLI constructs exactly one `MeduzaSource`;
- `runPipeline` accepts one `NewsSource`;
- `NewsSource` only exposes `discover(since)`;
- every discovered item is then passed through the same Readability web extraction path;
- source configuration such as the Meduza RSS URL lives directly on `AppConfig`;
- analysis/rendering assumes every item is a news article.

That model must remain backward-compatible for Meduza but become extensible enough for API-backed discussions.

## Target architecture

```text
persistent source configs
        │
        ▼
SourceConfigService / SourceRegistry
        │
        ├── Meduza adapter
        ├── Reddit adapter (Task 14)
        └── future adapters
        │
        ▼
per-source discover + materialize
        │
        ▼
normalized content records
(article | discussion | future kinds)
        │
        ▼
shared analysis + editorial selection
        │
        ▼
one mixed morning EPUB
```

## Required changes

### 1. Introduce stable source-instance configuration

Add a numbered SQLite migration for persistent non-secret source configuration.

A source instance should have at least:

- stable `id`,
- `type`,
- `enabled`,
- human-readable display name,
- versioned/validated source-specific settings JSON,
- created/updated timestamps.

Example conceptual rows:

```text
id                 type     enabled   settings
meduza             meduza   true      { "rssUrl": "https://meduza.io/rss/all" }
reddit:selfhosted  reddit   true      { "subreddit": "selfhosted", ... }
reddit:homelab     reddit   true      { "subreddit": "homelab", ... }
```

Do not store API keys, OAuth client secrets, passwords, or bearer tokens in source settings. Provider credentials remain in the protected process environment until a later explicit secret-management design exists.

Use strict runtime validation for every source type's settings. Invalid persisted settings must produce a clear configuration/doctor error rather than failing deep in a scheduled run.

### 2. Preserve Meduza with a bootstrap/migration path

Existing deployments must continue working without manually editing SQLite.

Provide a deterministic bootstrap path for the existing Meduza source. On an upgraded database with no configured sources, create or expose the default `meduza` source using the existing `MEDUZA_RSS_URL` value/default.

Do not silently overwrite an explicitly persisted Meduza setting on every startup. Define which input is authoritative after bootstrap and document it.

A reasonable transition is:

- `MEDUZA_RSS_URL` remains a bootstrap/default compatibility input;
- once a persisted Meduza source exists, its stored non-secret settings are authoritative;
- the later admin GUI edits the persisted setting.

### 3. Add a source configuration repository/service boundary

Create a storage repository plus domain service for source configuration. The service should support at least:

- list all sources,
- get one source,
- create a source from a validated type/settings payload,
- update non-secret settings/display name,
- enable/disable,
- prevent unsafe ID/type mutation after creation.

Deletion is not required in the first version; disabling is safer because existing articles/checkpoints may refer to the source ID.

Keep this service independent of HTTP. The later admin GUI should be able to expose it through admin routes without moving source configuration again.

### 4. Add minimal CLI administration before the GUI exists

Provide a small bootstrap/admin surface so source configuration is usable before the GUI task.

At minimum support commands equivalent to:

```text
sources list
sources add <type> ...
sources enable <id>
sources disable <id>
```

Exact syntax may differ, but it must be scriptable and documented.

The CLI must not print secrets. Reddit-specific add syntax is implemented in Task 14, but the generic command/service structure belongs here.

### 5. Replace the discovery-only source interface

Generalize `NewsSource` into an adapter contract that owns both discovery and source-specific materialization.

The contract should conceptually support:

```ts
interface SourceAdapter {
  readonly id: string;
  readonly type: string;
  discover(since: Date): Promise<DiscoveredItem[]>;
  materialize(item: DiscoveredItem): Promise<MaterializedContent>;
}
```

Names may differ, but the important boundary is that the pipeline no longer assumes a discovered URL must be fetched with Readability.

Move the existing Meduza web fetch/Readability behavior behind the Meduza adapter or a reusable web-article materializer used by that adapter.

Do not put `if (source.type === "reddit")` branches throughout the pipeline.

### 6. Introduce normalized content kind/context

Extend the normalized content domain so downstream components can distinguish at least:

```text
article
 discussion
```

Keep the existing `Article` storage/table naming if renaming it would create unnecessary migration risk, but add a stable content-kind field and bounded source context/metadata needed for attribution and rendering.

Source context must be validated and must not become an unbounded dump of provider responses.

For future Reddit use, the model needs room for non-secret fields such as:

- subreddit,
- Reddit post ID/permalink,
- score/comment-count snapshot,
- flair,
- content kind.

Do not require those Reddit fields in this task.

### 7. Generalize analysis language from "facts" to "key points"

The shared analysis domain currently assumes news articles and `keyFacts`. Discussions must not present participant opinions as verified facts.

Generalize the domain/prompt/rendering contract to a neutral concept such as `keyPoints`, while preserving existing Meduza semantics.

If the SQLite column/schema name cannot be changed safely, a compatibility mapping is acceptable, but the public TypeScript/domain model and rendered labels should be content-kind aware.

Bump prompt/analysis versions where required so old cached outputs are not incorrectly interpreted under a changed schema.

For articles, prompts can continue asking for factual takeaways. For discussions, Task 14 will provide discussion-specific instructions.

### 8. Process multiple enabled sources in one run

Change pipeline orchestration so `run` resolves all enabled source configs, instantiates adapters through a registry/factory, and processes them in a deterministic order.

Requirements:

- each source uses its own checkpoint;
- discovery failure in one source does not abort discovery from other sources;
- materialization/analysis failures are attributed to the correct source;
- a source checkpoint advances only according to that source's successfully handled/failed items;
- if at least one source produces usable content, the edition may still be generated;
- if no enabled source produces usable content, fail clearly and preserve the previous edition;
- the global pipeline lock remains one lock for the whole edition run.

Do not create one EPUB per source.

### 9. Add source-run observability suitable for the future GUI

Persist or expose a compact per-source last-run status that can later be shown in an admin screen without parsing logs.

Include at least:

- source ID/type,
- last attempt time,
- last successful checkpoint/run time,
- discovered count,
- successfully processed count,
- failed count,
- bounded safe error code/message when discovery itself fails.

Do not persist stack traces, secrets, raw provider payloads, or raw content in status rows.

Keep the existing overall `run-status.json`/health behavior intact.

### 10. Make editorial selection explicitly source-aware

Run editorial selection once across all successfully analyzed content.

Add deterministic source/source-kind diversity controls so one high-volume source cannot crowd out the edition. Prefer a simple configurable rule that the fallback can enforce exactly, for example:

- maximum selected items per source instance and/or source type,
- source-level candidate limits before editorial selection.

The LLM editorial prompt and deterministic fallback must apply the same constraints.

Do not introduce opaque learned ranking or user-personalization in this task.

### 11. Keep rendering backward-compatible and content-kind aware

Existing Meduza editions should retain their current article presentation.

The renderer must accept normalized content kinds and expose enough context to render future discussions differently. It is sufficient in this task to establish the branch/renderer contract and keep `article` output unchanged; Task 14 will add Reddit-specific labels/metadata.

### 12. Doctor/config validation

Extend `doctor` to validate:

- the source configuration store can be read,
- at least one source is enabled for a real run,
- every enabled source has valid settings,
- adapter type is registered,
- provider-specific secret requirements can be reported by the adapter/provider without exposing values.

Task 13 should keep Meduza-only deployments passing without Reddit credentials.

### 13. Documentation

Update `.env.example` and README only where required for the new source configuration model and CLI.

Document that source settings are persisted in SQLite and are intended to be managed by the later admin GUI.

Do not document Reddit as available until Task 14 implements it.

## Migration and compatibility requirements

- Existing article/version/analysis/edition history must remain readable.
- Existing source checkpoint for `meduza` must continue to be used.
- Upgrading an existing Meduza-only database must not cause all old content to be reprocessed unnecessarily.
- Existing Docker/data-volume deployment requires no filesystem migration beyond normal SQLite migrations.
- No secrets move from `.env` into SQLite.

## Tests and validation

Add focused tests for:

1. source config migration/bootstrap on a fresh database;
2. upgrade of an existing Meduza database;
3. strict source settings validation;
4. source config CRUD/enable-disable behavior;
5. source registry unknown-type failure;
6. Meduza through the new `discover + materialize` adapter path;
7. two fake sources in one run producing one combined edition;
8. one source discovery failure while another succeeds;
9. independent checkpoints for multiple sources;
10. source-specific partial failure checkpoint behavior;
11. deterministic source diversity in fallback selection;
12. analysis cache/version compatibility after the key-points generalization;
13. source-run status persistence/redaction;
14. `doctor` with valid and invalid source configurations.

Run the full existing test suite and Docker smoke tests because this task changes core orchestration.

## Acceptance criteria

- The pipeline no longer constructs or assumes one hard-coded source.
- Enabled source instances come from a persistent, validated source configuration service.
- Existing Meduza installs upgrade automatically and retain behavior/history.
- Source adapters own both discovery and materialization.
- One run can combine at least two fake/real adapters into one edition.
- Source failures/checkpoints are isolated.
- Normalized content is aware of article vs discussion kinds.
- Shared analysis/rendering terminology no longer mislabels discussion opinions as facts.
- Editorial selection has deterministic source-diversity limits.
- Per-source operational status exists for the later admin GUI.
- Source settings can be listed/enabled/disabled without a GUI.
- Secrets remain outside the source configuration database.
- Full tests and container smoke validation pass.

## Admin GUI compatibility requirements

The next admin-GUI task should be able to build on this task without another configuration migration. Keep these stable seams:

- `SourceConfigRepository`/service (or equivalent),
- typed source settings schemas,
- source-type registry metadata,
- safe source status model,
- enable/disable/update operations,
- separation of non-secret settings from provider credentials.

Do not couple those APIs to CLI argument parsing.

## Non-goals

Do not:

- implement Reddit yet,
- implement the admin GUI or admin HTTP API,
- add user accounts/authentication,
- add Telegram or generic RSS UI,
- move secrets into SQLite,
- create one edition per source,
- redesign Docker/systemd deployment,
- add Wake-on-LAN.

## Suggested commit

```text
feat: generalize pipeline for multiple sources
```
