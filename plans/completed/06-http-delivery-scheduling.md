# Task 06 — Home-server delivery, scheduling, and operations

## Agent prompt

Make the server MVP suitable for 24/7 deployment on a small Linux home server using systemd, with a morning timer and simple operational diagnostics.

## Goals

- Run one service continuously for HTTP delivery.
- Run one scheduled pipeline job around 06:00–06:30.
- Avoid overlapping morning jobs.
- Make failures visible in logs and health checks.

## Work

- Add systemd service examples for delivery and one-shot generation.
- Add a systemd timer example with a configurable morning schedule.
- Add a process/file lock so two pipeline runs cannot overlap.
- Expand `/healthz` with safe status: server health, latest edition date, latest file presence, last successful run timestamp.
- Add graceful shutdown for the HTTP server.
- Add retention policy for dated EPUB/build directories while keeping the database history.
- Document firewall/LAN assumptions; default recommendation is LAN-only exposure or reverse proxy with authentication if exposed further.
- Add operations documentation for journalctl, manual rerun, and rollback to previous EPUB.

## Acceptance criteria

- Provided units use absolute paths/placeholders clearly documented for customization.
- A second concurrent `run` exits cleanly without duplicating work.
- Delivery can continue serving yesterday's edition if today's generation fails.
- No API keys are embedded in unit files committed to git.
- `npm run check` passes.

## Non-goals

No Kubernetes, Docker Swarm, cloud deployment, or public SaaS hosting.

## Suggested commit

`ops: add systemd scheduling and service health`
