# Implementation plan for coding agents

These files are designed to be fed one at a time to Codex, Qwen, or another coding agent. The tasks are intentionally small enough to review and commit independently.

## How to use

For each task:

1. Give the agent the repository plus exactly one task file.
2. Ask it to inspect the current code before editing.
3. Require it to run `npm run check` before finishing.
4. Review the diff and acceptance criteria.
5. Commit the task separately using the suggested commit message.
6. Only then move to the next task.

Agents should preserve the core boundary:

```text
source -> extraction -> normalized Article -> storage -> analysis -> editorial plan -> renderer -> delivery
```

Source-specific authentication, browser automation, and parsing must not leak into the editorial or rendering layers.

## Recommended order

1. [`00-foundation-hardening.md`](00-foundation-hardening.md)
2. [`01-meduza-ingestion.md`](01-meduza-ingestion.md)
3. [`02-storage-dedup.md`](02-storage-dedup.md)
4. [`03-llm-summarization.md`](03-llm-summarization.md)
5. [`04-editorial-selection.md`](04-editorial-selection.md)
6. [`05-epub-rendering.md`](05-epub-rendering.md)
7. [`06-http-delivery-scheduling.md`](06-http-delivery-scheduling.md)
8. [`07-kindle-scribe-sync.md`](07-kindle-scribe-sync.md)
9. [`08-additional-sources.md`](08-additional-sources.md)
10. [`09-personalization-and-clustering.md`](09-personalization-and-clustering.md)

Tasks 00–06 complete the server MVP. Task 07 is the separate Scribe-side project. Tasks 08–09 expand the product after the end-to-end morning workflow is stable.
