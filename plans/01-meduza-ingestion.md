# Task 01 — Productionize Meduza ingestion

## Agent prompt

Make the Meduza source adapter and article extraction robust enough for unattended daily use. Preserve RSS for discovery and Readability-style extraction for article text.

## Goals

- Reliably discover recent Meduza items from RSS.
- Fetch articles politely and retry transient failures.
- Extract title, author, body, publication metadata, and canonical URL.
- Make extraction regressions testable using local fixtures.

## Work

- Add HTTP retry/backoff with timeout and a configurable user-agent.
- Normalize Meduza URLs and prefer canonical URLs from document metadata.
- Add source-specific extraction cleanup only where generic Readability output is insufficient.
- Add HTML fixture tests from representative Meduza article shapes. Fixtures must be small and contain only the minimum markup needed for testing.
- Detect non-article pages and empty/very-short extraction.
- Record fetch/extraction failure reasons without aborting the full morning run.
- Respect reasonable request concurrency and delays.

## Acceptance criteria

- Discovery is driven by RSS, not homepage scraping.
- The same article URL normalizes to one canonical record.
- One failed article does not fail the complete run.
- Tests cover normal extraction, malformed HTML, HTTP failure, and duplicate URLs.
- `npm run check` passes without network access for unit tests.

## Non-goals

Do not add browser automation, paywall bypasses, Telegram, Reddit, Facebook, or X.

## Suggested commit

`feat: harden Meduza ingestion and extraction`
