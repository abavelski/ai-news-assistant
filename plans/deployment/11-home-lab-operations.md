# Task 11 — Docker-aware home-lab installation and scheduling

## Goal

Turn the Docker runtime from Task 10 into a practical Linux home-lab deployment with a small host-side systemd surface for boot startup and the existing morning schedule.

The host should need Docker Engine, Docker Compose, the deployment files, and persistent storage. It should not need Node.js, npm, Pandoc, or native npm build dependencies once a suitable image is available.

## Prerequisite

Complete Task 10 first.

Use the image/Compose contract established there rather than creating a second deployment mechanism.

## Read first

Inspect:

- `compose.yaml`
- `.env.example`
- `ops/systemd/README.md`
- `ops/systemd/ai-news-assistant-serve.service`
- `ops/systemd/ai-news-assistant-run.service`
- `ops/systemd/ai-news-assistant-run.timer`
- `src/operations/run-lock.ts`
- `src/operations/status.ts`
- `src/operations/retention.ts`

Preserve the existing run-lock, health, and retention behavior.

## Required changes

### 1. Make systemd operate Docker Compose, not Node directly

Replace or add deployment units so the host-side services call Docker Compose.

The desired operational model is:

- the long-running HTTP application is managed by `docker compose up -d` / Compose restart policy,
- the one-shot generation service runs:

```text
docker compose run --rm app run
```

- the existing timer starts that one-shot service each morning.

Do not run cron or systemd inside the application container.

Keep the existing ~06:00 plus randomized-delay schedule unless there is a compelling operational reason to change it.

### 2. Define clear server paths

Document one recommended layout, for example:

```text
/opt/ai-news-assistant/
  compose.yaml
  .env

/var/lib/ai-news-assistant/
  ...persistent application data...
```

Use absolute paths where systemd requires them.

The deployment must make ownership/permissions of the persistent data directory explicit, especially because the container runs as a non-root UID/GID.

Avoid `chmod 777`.

### 3. Make port exposure explicit and safe

Document how to bind the delivery port:

- trusted LAN directly, or
- localhost only when a reverse proxy/VPN will provide access.

Do not imply the unauthenticated HTTP endpoint is safe for direct public-internet exposure.

If Compose uses separate host-bind and container-bind settings, name/document them clearly so users do not accidentally set container `HOST=127.0.0.1` and make the service unreachable through Docker port forwarding.

### 4. Document local-LLM networking

Include a working Linux example for an LLM running on the Docker host:

```dotenv
LLM_BASE_URL=http://host.docker.internal:11434
```

Explain the `host-gateway` Compose mapping.

Also document the cloud OpenAI case where no special Docker networking is required.

### 5. Add install/start procedure

Create a concise home-lab install guide covering:

1. install Docker Engine + Compose plugin,
2. place deployment files,
3. create persistent data directory,
4. create `.env` without committing secrets,
5. build or pull the image,
6. run `doctor` inside the container,
7. start `serve`,
8. install/enable the systemd timer,
9. perform one manual generation,
10. verify `/healthz` and `latest.epub`.

Prefer copy/pasteable commands with placeholders that are clearly identified.

### 6. Add update procedure

Document a safe update flow.

For locally built images:

```text
git pull
docker compose build
docker compose up -d
```

For registry images once Task 12 exists:

```text
docker compose pull
docker compose up -d
```

The procedure must not remove the persistent data directory.

Document how to inspect container/service logs after an update.

### 7. Add rollback and backup guidance

Document:

- pinning/changing an image tag to roll back application code,
- restarting Compose after a tag change,
- why SQLite/EPUB data remains intact,
- backing up the persistent data directory before risky upgrades.

Do not automate destructive database rollback.

### 8. Validate scheduling and locking

Confirm that:

- systemd's one-shot job receives the same `.env` and data mount as the long-running server,
- `pipeline.lock` is visible to all one-shot containers through the shared data directory,
- a concurrent manual run cannot duplicate the scheduled run,
- a failed morning run leaves the previous `latest.epub` available.

## Tests and validation

Run:

```bash
npm run check
docker compose config
systemd-analyze verify <docker-aware unit files>
```

Where practical, add shell-level validation that checks expected Compose/systemd command lines without actually requiring a real morning LLM run.

Perform a manual dry/smoke sequence using a non-paid configuration:

- `docker compose up -d`
- healthcheck succeeds,
- `docker compose run --rm app doctor` succeeds with a dummy model,
- systemd unit syntax verifies,
- persistent data remains after `docker compose down` followed by `up -d`.

Do not use `docker compose down -v` in the documented normal update path.

## Acceptance criteria

- No production systemd unit invokes host Node.js directly.
- Morning generation is a one-shot Compose container.
- The delivery container starts/restarts predictably.
- Scheduling uses the existing systemd timer model.
- Persistent data is shared between `serve` and `run`.
- Install, update, rollback, backup, logs, LAN exposure, and host-local LLM networking are documented.
- Secrets remain outside images and committed unit files.
- Host no longer needs Node/Pandoc for normal Docker deployment.
- Existing application lock/status/retention behavior remains unchanged.

## Non-goals

Do not:

- add an in-container scheduler,
- publish images to GHCR in this task,
- add automatic OS/Docker installation scripts for every distro,
- add public TLS/authentication proxying,
- change application pipeline semantics.

## Suggested commit

```text
ops: add Docker home-lab deployment workflow
```
