# Task 05 — Kindle-friendly EPUB rendering

## Agent prompt

Turn the basic Pandoc output into a polished, deterministic EPUB3 morning newspaper optimized for a large monochrome e-ink screen such as Kindle Scribe/KOReader.

## Goals

- Produce a pleasant table of contents and hierarchy.
- Make summaries scannable and full text comfortable to read.
- Keep editions deterministic and offline-friendly.
- Preserve source attribution and original URLs.

## Work

- Introduce templates/CSS under a rendering assets directory.
- Create sections for Morning Brief, Top Stories, topic groupings when useful, and Other Headlines if available.
- Add estimated reading time.
- Sanitize article content before putting it in the EPUB.
- Decide and document image policy; initially support no images or a single bounded lead image per selected article.
- Add EPUB metadata: title, date, language, author/publisher string, identifier.
- Validate Pandoc output exists and is non-empty before replacing `latest.epub`.
- Write latest files atomically.
- Add a renderer abstraction so Pandoc could be replaced later.

## Acceptance criteria

- A failed render cannot corrupt the previous `latest.epub`.
- Generated EPUB has a table of contents and valid metadata.
- Full article inclusion remains configurable.
- Renderer unit tests do not require Pandoc; one optional integration test may.
- `npm run check` passes.

## Non-goals

Do not implement Kindle device sync in this task.

## Suggested commit

`feat: render polished atomic EPUB editions`
