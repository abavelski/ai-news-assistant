# Docker home-lab deployment plan

Goal: make the tested MVP practical on a weak Linux home-lab server without publishing Docker images or requiring the server to build them.

The implemented operating model is:

```text
Strong amd64 build machine / gaming rig
├── public Git repository checkout
├── git pull --ff-only
├── docker build + smoke validation
└── docker save -> compressed image artifact
                    │
                    │ trusted-LAN SCP/SSH
                    ▼
Weak Lenovo home server
├── Docker / Docker Compose
│   ├── preloaded immutable image tag
│   ├── long-running app container: `serve`
│   └── temporary one-shot container: `run`
├── persistent host data directory
│   ├── news.sqlite
│   ├── run-status.json
│   ├── builds/
│   └── public/daily/
└── systemd timer
    └── `docker compose run --rm --pull never app run`

Separate LAN LLM machine (normally gaming rig when powered on)
└── OpenAI-compatible endpoint reached by LAN IP/local DNS
```

The Git repository is the only published project artifact. Docker images remain local: they are built on the stronger machine, exported with `docker save`, transferred over the LAN, and loaded on the Lenovo with `docker load`.

The container image contains Node.js, production dependencies, Pandoc, compiled application code, and EPUB rendering assets. SQLite data and generated editions live outside the container in persistent home-server storage.

The LLM does not run on the Lenovo. The container connects to a separate LAN endpoint such as `http://gaming-rig.home.arpa:11434` when that machine is available. Wake-on-LAN orchestration may be added later as a separate task.

## Completed tasks

1. [`10-docker-runtime.md`](10-docker-runtime.md) — Docker/Compose runtime contract and container smoke validation.
2. [`11-home-lab-operations.md`](11-home-lab-operations.md) — local build/export/transfer workflow, Docker-aware systemd scheduling, persistent server storage, LAN LLM configuration, update/rollback/backup operations.

There is intentionally no registry-publishing task. Do not add GHCR/Docker Hub publishing unless the deployment model changes in the future. Wake-on-LAN remains a possible future task.
