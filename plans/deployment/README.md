# Docker home-lab deployment plan

Goal: make the tested MVP installable on a Linux home-lab server with minimal host dependencies and a predictable update/rollback path.

The target operating model is:

```text
Linux host
├── Docker / Docker Compose
│   ├── long-running app container: `serve`
│   └── temporary one-shot container: `run`
├── persistent host data directory
│   ├── news.sqlite
│   ├── run-status.json
│   ├── builds/
│   └── public/daily/
└── systemd timer
    └── `docker compose run --rm app run`
```

The container image must contain Node.js, production dependencies, Pandoc, compiled application code, and EPUB rendering assets. SQLite data and generated editions must live outside the container on a persistent bind mount or named volume.

## Order

1. [`10-docker-runtime.md`](10-docker-runtime.md)
2. [`11-home-lab-operations.md`](11-home-lab-operations.md)
3. [`12-ghcr-publishing.md`](12-ghcr-publishing.md)

The tasks are intentionally separate so each can be reviewed and committed independently. Do not redesign the application or move scheduling into the container unless a task explicitly requires it.
