# Implementation plans

The server MVP and home-lab deployment are complete. Completed implementation tasks are archived under [`completed/`](completed/), with a concise MVP summary in [`MVP-SUMMARY.md`](MVP-SUMMARY.md).

## Active work — multiple sources and Reddit

The next workstream generalizes the single-source Meduza pipeline and then adds Reddit discussion digests.

1. [`13-multi-source-foundation.md`](sources/13-multi-source-foundation.md) — source registry, persistent source configuration, source-specific content materialization, multi-source orchestration, mixed-source editorial selection, and contracts intended to be reused by a later admin GUI.
2. [`14-reddit-discussions.md`](sources/14-reddit-discussions.md) — OAuth Reddit ingestion, configurable subreddit subscriptions, bounded thread/comment materialization, discussion-aware LLM analysis, source-aware rendering, rate limiting, and privacy/retention safeguards.

See [`sources/README.md`](sources/README.md) for the architecture and sequencing rationale.

The admin GUI is intentionally not part of these tasks. The source configuration repository/service created in Task 13 should be the backend domain boundary that a later GUI uses rather than introducing a second configuration mechanism.

## Completed tasks

1. [`00-foundation-hardening.md`](completed/00-foundation-hardening.md)
2. [`01-meduza-ingestion.md`](completed/01-meduza-ingestion.md)
3. [`02-storage-dedup.md`](completed/02-storage-dedup.md)
4. [`03-llm-summarization.md`](completed/03-llm-summarization.md)
5. [`04-editorial-selection.md`](completed/04-editorial-selection.md)
6. [`05-epub-rendering.md`](completed/05-epub-rendering.md)
7. [`06-http-delivery-scheduling.md`](completed/06-http-delivery-scheduling.md)
8. [`10-docker-runtime.md`](completed/10-docker-runtime.md)
9. [`11-home-lab-operations.md`](completed/11-home-lab-operations.md)

There is no container-registry publishing task. Production images continue to be built on a stronger local machine and transferred directly to the home server. Wake-on-LAN for the separate gaming-rig LLM remains a possible future task.
