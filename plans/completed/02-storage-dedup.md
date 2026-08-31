# Task 02 — Storage, migrations, and deduplication

## Agent prompt

Turn the current SQLite persistence into a versioned, idempotent storage layer suitable for repeated daily runs and article updates.

## Goals

- Re-running the same morning job should be safe.
- Unchanged content must not be re-summarized.
- Updated articles should retain useful history.
- Database schema changes should be explicit and testable.

## Work

- Introduce numbered SQLite migrations.
- Add article version/history support keyed by normalized URL and content hash.
- Define transaction boundaries around article upsert + analysis invalidation.
- Add useful indexes for source, publication time, URL, hash, and edition membership.
- Make source checkpoints safe: only advance a source checkpoint after the source phase is complete enough not to lose items.
- Add repository methods rather than scattering SQL through the pipeline.
- Add tests using temporary SQLite databases.

## Acceptance criteria

- Two identical runs create no duplicate article/version rows.
- A changed body creates a new version and invalidates stale analysis.
- A failed run cannot permanently skip undiscovered content merely because a checkpoint advanced too early.
- Migrations can initialize an empty database and upgrade an older fixture.
- `npm run check` passes.

## Non-goals

No PostgreSQL, Redis, vector database, or distributed job queue.

## Suggested commit

`feat: add idempotent versioned SQLite storage`
