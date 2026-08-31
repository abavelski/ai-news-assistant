# Implementation plans

The server MVP is complete and tested. The original MVP implementation tasks are retained for historical reference under [`completed/`](completed/), with a concise delivered-system summary in [`MVP-SUMMARY.md`](MVP-SUMMARY.md).

The Docker home-lab deployment workstream is now implemented. Deployment images are built on a stronger local machine and transferred directly over the LAN to the weak server; only the Git repository is published.

## Completed deployment work

1. [`10-docker-runtime.md`](deployment/10-docker-runtime.md) — reproducible Docker image, Compose runtime, persistent data contract, and container smoke tests.
2. [`11-home-lab-operations.md`](deployment/11-home-lab-operations.md) — local image build/export/transfer, host-visible persistence, Docker-aware systemd scheduling, LAN LLM configuration, update, rollback, backup, and cleanup procedures.

There is no container-registry publishing task. GHCR/Docker Hub publishing is intentionally out of scope for the current deployment model. Wake-on-LAN for the separate gaming-rig LLM may be planned later as its own task.

## Completed MVP tasks

1. [`00-foundation-hardening.md`](completed/00-foundation-hardening.md)
2. [`01-meduza-ingestion.md`](completed/01-meduza-ingestion.md)
3. [`02-storage-dedup.md`](completed/02-storage-dedup.md)
4. [`03-llm-summarization.md`](completed/03-llm-summarization.md)
5. [`04-editorial-selection.md`](completed/04-editorial-selection.md)
6. [`05-epub-rendering.md`](completed/05-epub-rendering.md)
7. [`06-http-delivery-scheduling.md`](completed/06-http-delivery-scheduling.md)
