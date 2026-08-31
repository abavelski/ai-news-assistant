# Task 04 — Editorial selection and morning briefing

## Agent prompt

Improve the second-pass editorial stage so it behaves like a conservative personal newspaper editor rather than a simple importance sort.

## Goals

- Select a compact, varied set of meaningful stories.
- Avoid duplicate coverage within one source.
- Produce a coherent Russian morning overview.
- Have deterministic fallbacks if the editorial model fails.

## Work

- Define and validate a structured editorial-plan schema.
- Give the editor enough metadata to identify duplicate/near-duplicate stories without full article text.
- Add configurable section/topic balance and maximum story count.
- Add deterministic fallback ranking using importance, freshness, and recommendation status.
- Prevent the LLM from selecting unknown IDs or duplicate IDs.
- Store editorial prompt/model versions with the edition.
- Add fake-provider tests for bad IDs, duplicates, empty selection, malformed output, and fallback behavior.

## Acceptance criteria

- An editorial LLM failure still produces a readable edition from deterministic ranking.
- Selected IDs are unique, valid, and within configured limits.
- Overview language follows `EDITION_LANGUAGE`.
- The editorial stage never needs raw full article bodies.
- `npm run check` passes.

## Non-goals

Cross-source story clustering is a later task; only lightweight duplicate avoidance is needed here.

## Suggested commit

`feat: make editorial selection resilient and deterministic`
