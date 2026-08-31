# Implementation plans

The server MVP is complete and tested. The original MVP implementation tasks are retained for historical reference under [`completed/`](completed/), with a concise delivered-system summary in [`MVP-SUMMARY.md`](MVP-SUMMARY.md).

The active workstream is packaging and operating the MVP on a weak Linux home-lab server using Docker and Docker Compose. Deployment images are built on a stronger local machine and transferred directly over the LAN; only the Git repository is published.

## Deployment tasks

1. [`10-docker-runtime.md`](deployment/10-docker-runtime.md) — completed reproducible Docker image, Compose runtime, persistent data contract, and container smoke tests.
2. [`11-home-lab-operations.md`](deployment/11-home-lab-operations.md) — next: build/export on a strong local machine, SCP/SSH image transfer to the Lenovo, `docker load`/`--no-build` deployment, Docker-aware systemd scheduling, persistent backups/rollback, and a separate LAN LLM endpoint.

There is no container-registry publishing task. GHCR/Docker Hub publishing is intentionally out of scope for the current deployment model. Wake-on-LAN for the separate gaming-rig LLM may be planned later as its own task.

## Completed MVP tasks

1. [`00-foundation-hardening.md`](completed/00-foundation-hardening.md)
2. [`01-meduza-ingestion.md`](completed/01-meduza-ingestion.md)
3. [`02-storage-dedup.md`](completed/02-storage-dedup.md)
4. [`03-llm-summarization.md`](completed/03-llm-summarization.md)
5. [`04-editorial-selection.md`](completed/04-editorial-selection.md)
6. [`05-epub-rendering.md`](completed/05-epub-rendering.md)
7. [`06-http-delivery-scheduling.md`](completed/06-http-delivery-scheduling.md)
