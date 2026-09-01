# Implementation plans

The server MVP, home-lab deployment, multi-source foundation, and Reddit discussion source are complete. Completed implementation tasks are archived under [`completed/`](completed/), with a concise MVP summary in [`MVP-SUMMARY.md`](MVP-SUMMARY.md).

## Next work — admin GUI

The next planned workstream is an admin GUI built on the source configuration repository/service and source-type descriptors introduced by Tasks 13–14. It should list source instances and status, add/edit/enable/disable sources, show whether protected provider credentials are configured without exposing them, and surface the Reddit LLM trust-boundary state.

Do not introduce a second source configuration store for the GUI; reuse the existing service/domain layer.

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
10. [`13-multi-source-foundation.md`](completed/13-multi-source-foundation.md)
11. [`14-reddit-discussions.md`](completed/14-reddit-discussions.md)

There is no container-registry publishing task. Production images continue to be built on a stronger local machine and transferred directly to the home server. Wake-on-LAN for the separate gaming-rig LLM remains a possible future task.
