# Implementation plans

The server MVP is complete and tested. The original MVP implementation tasks are retained for historical reference under [`completed/`](completed/), with a concise delivered-system summary in [`MVP-SUMMARY.md`](MVP-SUMMARY.md).

The next active workstream is packaging the MVP for simple Linux home-lab installation with Docker and Docker Compose. Those tasks live under [`deployment/`](deployment/).

## Active deployment tasks

1. [`10-docker-runtime.md`](deployment/10-docker-runtime.md) — reproducible Docker image, Compose runtime, persistent data, and container smoke tests.
2. [`11-home-lab-operations.md`](deployment/11-home-lab-operations.md) — Docker-aware systemd scheduling, install/update/rollback workflow, and host/local-LLM networking.
3. [`12-ghcr-publishing.md`](deployment/12-ghcr-publishing.md) — multi-architecture GHCR publishing and release/tag workflow.

Task 10 should be completed first. Task 11 may use locally built images initially and should remain compatible with Task 12 once published images are available. Task 12 depends on the Docker image contract established in Task 10.

## Completed MVP tasks

1. [`00-foundation-hardening.md`](completed/00-foundation-hardening.md)
2. [`01-meduza-ingestion.md`](completed/01-meduza-ingestion.md)
3. [`02-storage-dedup.md`](completed/02-storage-dedup.md)
4. [`03-llm-summarization.md`](completed/03-llm-summarization.md)
5. [`04-editorial-selection.md`](completed/04-editorial-selection.md)
6. [`05-epub-rendering.md`](completed/05-epub-rendering.md)
7. [`06-http-delivery-scheduling.md`](completed/06-http-delivery-scheduling.md)
