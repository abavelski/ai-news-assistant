# Docker home-lab deployment

These units implement the production home-lab model for a weak Linux server. The server does not build the application and does not run Node.js, npm, Pandoc, a compiler, or the LLM directly. It only runs Docker/Compose, keeps persistent application data, serves the latest EPUB, and starts the scheduled one-shot generator.

The examples assume:

- public Git checkout and Compose files: `/opt/ai-news-assistant`
- persistent application data: `/var/lib/ai-news-assistant`
- server configuration/secrets: `/opt/ai-news-assistant/.env`
- Docker CLI: `/usr/bin/docker`
- locally loaded image tag: `ai-news-assistant:<12-character-git-sha>`
- a separate OpenAI-compatible LLM reachable over the trusted LAN

The systemd units run Docker as root. Access to the Docker daemon is root-equivalent, so moving the units to an unprivileged account that belongs to the `docker` group does not materially reduce that privilege. Keep the deployment checkout and `.env` root-controlled on the server.

## 1. Build and export on the stronger machine

Production images are built from a clean Git revision on a stronger `linux/amd64` machine (or a machine able to build `linux/amd64` Docker images). The Git repository is the only published artifact; no container registry is used.

```bash
git pull --ff-only
npm ci
npm run check
./scripts/build-deployment-image.sh
```

The packaging script refuses a dirty Git tree, tags the image from the current 12-character Git SHA, builds the production runtime image, runs the existing non-paid Docker smoke suite, verifies the requested platform, and writes:

```text
artifacts/ai-news-assistant-<git-sha>.tar.gz
artifacts/ai-news-assistant-<git-sha>.tar.gz.sha256
```

The default image identity is `ai-news-assistant:<git-sha>`. The archive is produced with `docker save`; it is not uploaded anywhere. `artifacts/` is ignored by Git and Docker build context.

## 2. Transfer and load over the trusted LAN

```bash
./scripts/transfer-deployment-image.sh \
  artifacts/ai-news-assistant-<git-sha>.tar.gz \
  homelab
```

The helper transfers the archive and checksum with SCP, verifies the checksum on the server, loads the image with `docker load`, then removes only the transferred archive/checksum from the server. The SSH account must be able to run `docker`.

Dry-run the command construction without transferring anything:

```bash
AI_NEWS_TRANSFER_DRY_RUN=1 \
./scripts/transfer-deployment-image.sh \
  artifacts/ai-news-assistant-<git-sha>.tar.gz \
  homelab
```

Older `ai-news-assistant:<git-sha>` images are deliberately not deleted so they remain available for rollback.

## 3. Prepare the Lenovo server

Install Docker Engine, the Docker Compose plugin, Git, SSH administration tools, `gzip`, and `sha256sum`. The server does not need Node.js/npm/Pandoc/build-essential.

```bash
sudo git clone https://github.com/abavelski/ai-news-assistant.git /opt/ai-news-assistant
cd /opt/ai-news-assistant
sudo git pull --ff-only
sudo cp .env.example .env
sudo chmod 0600 .env
sudo $EDITOR .env
```

Configure the already loaded immutable image tag, host-visible persistent path, delivery bind, and the separate LAN LLM:

```dotenv
AI_NEWS_IMAGE=ai-news-assistant:<git-sha>
AI_NEWS_DATA_DIR=/var/lib/ai-news-assistant
AI_NEWS_BIND_ADDRESS=192.168.1.20
AI_NEWS_HTTP_PORT=8787

LLM_BASE_URL=http://gaming-rig.home.arpa:11434
LLM_MODEL=your-model-name
```

For a cloud provider, use its HTTPS base URL and put `LLM_API_KEY` only in this protected `.env`.

After the image is loaded, derive its configured runtime UID/GID rather than assuming a number:

```bash
IMAGE=ai-news-assistant:<git-sha>
APP_UID="$(sudo docker run --rm --entrypoint id "$IMAGE" -u)"
APP_GID="$(sudo docker run --rm --entrypoint id "$IMAGE" -g)"
sudo install -d -m 0750 -o "$APP_UID" -g "$APP_GID" /var/lib/ai-news-assistant
```

Do not use `chmod 777`.

## 4. Validate and start without building or pulling

The production override is `ops/homelab/compose.yaml`. It replaces Task 10's named volume with the host-visible `AI_NEWS_DATA_DIR` bind mount and sets `pull_policy: never`.

```bash
cd /opt/ai-news-assistant
sudo docker compose \
  --env-file .env \
  -f compose.yaml \
  -f ops/homelab/compose.yaml \
  config
```

Run `doctor` using only the already loaded image:

```bash
sudo docker compose \
  --env-file .env \
  -f compose.yaml \
  -f ops/homelab/compose.yaml \
  run --rm --pull never app doctor
```

`docker compose run` has no `--no-build` flag. It builds only when explicitly asked with `--build`; `--pull never` plus the override's `pull_policy: never` makes a missing image fail instead of pulling it. The long-running service does support `--no-build`:

```bash
sudo docker compose \
  --env-file .env \
  -f compose.yaml \
  -f ops/homelab/compose.yaml \
  up -d --no-build app
```

Check health and logs:

```bash
curl -fsS http://192.168.1.20:8787/healthz
sudo docker compose --env-file .env -f compose.yaml -f ops/homelab/compose.yaml logs --tail=100 app
```

All SQLite state, run status, build state, dated EPUBs, `latest.epub`, and `latest.json` live under `/var/lib/ai-news-assistant` and survive container/image replacement.

## 5. Separate LAN LLM

The normal local-LLM deployment is another machine, typically the gaming rig:

```dotenv
LLM_BASE_URL=http://gaming-rig.home.arpa:11434
LLM_MODEL=your-model-name
```

A stable DHCP reservation/local DNS name is preferable. A fixed LAN IP also works. The LLM server must listen on an interface reachable from the LAN rather than only its own `127.0.0.1`, and the gaming-rig firewall must allow the Lenovo to reach the chosen port. Ordinary container outbound networking reaches the LAN address; no Docker host-gateway mapping is required for this cross-machine path.

If the gaming rig is powered off or the LLM is unreachable, generation may fail. Existing run-status/health behavior remains intact: the delivery service reports a degraded last attempt while the previous successful `latest.epub` stays available. Wake-on-LAN is intentionally deferred.

## 6. Install systemd scheduling

```bash
sudo install -m 0644 ops/systemd/ai-news-assistant-serve.service /etc/systemd/system/
sudo install -m 0644 ops/systemd/ai-news-assistant-run.service /etc/systemd/system/
sudo install -m 0644 ops/systemd/ai-news-assistant-run.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ai-news-assistant-serve.service
sudo systemctl enable --now ai-news-assistant-run.timer
```

The serve unit is a thin Compose wrapper. It runs `up -d --no-build`, after which Compose's `restart: unless-stopped` keeps delivery alive. The morning unit uses `docker compose run --rm --pull never app run`, sharing the same `.env` and `/var/lib/ai-news-assistant` bind mount.

The timer still starts at 06:00 with up to 30 minutes randomized delay. To override it:

```bash
sudo systemctl edit ai-news-assistant-run.timer
```

```ini
[Timer]
OnCalendar=
OnCalendar=*-*-* 06:15:00
RandomizedDelaySec=0
```

Run one generation manually when the LLM is available:

```bash
sudo systemctl start ai-news-assistant-run.service
journalctl -u ai-news-assistant-run.service -f
```

The application lock is inside the shared data directory, so scheduled and manual one-shot containers see the same `pipeline.lock`. A concurrent second run exits cleanly rather than duplicating work.

## 7. Normal update

On the stronger build machine:

```bash
git pull --ff-only
npm ci
npm run check
./scripts/build-deployment-image.sh
./scripts/transfer-deployment-image.sh \
  artifacts/ai-news-assistant-<new-git-sha>.tar.gz \
  homelab
```

On the Lenovo:

```bash
cd /opt/ai-news-assistant
sudo git pull --ff-only
sudo $EDITOR .env
```

Change `AI_NEWS_IMAGE` to the newly loaded immutable tag, then:

```bash
sudo docker compose --env-file .env -f compose.yaml -f ops/homelab/compose.yaml up -d --no-build app
curl -fsS http://192.168.1.20:8787/healthz
```

If the committed systemd units changed, reinstall them and run `systemctl daemon-reload`. Normal application image updates do not require reinstalling the timer.

Inspect image identity and logs:

```bash
sudo docker compose --env-file .env -f compose.yaml -f ops/homelab/compose.yaml images
sudo docker compose --env-file .env -f compose.yaml -f ops/homelab/compose.yaml logs --tail=200 app
```

## 8. Rollback

Keep at least one previously known-good image tag loaded. Change `AI_NEWS_IMAGE` in `.env` back to that tag and run:

```bash
sudo docker compose --env-file .env -f compose.yaml -f ops/homelab/compose.yaml up -d --no-build app
```

The bind-mounted `/var/lib/ai-news-assistant` directory is not replaced, so SQLite history and EPUBs remain intact. Do not automate database downgrades.

List/remove old images explicitly only when they are no longer needed for rollback:

```bash
sudo docker image ls ai-news-assistant
sudo docker image rm ai-news-assistant:<old-git-sha>
```

## 9. Backup and operations

Before a risky upgrade, prevent a new scheduled writer from starting and ensure no generation job is active:

```bash
sudo systemctl stop ai-news-assistant-run.timer
systemctl is-active ai-news-assistant-run.service
```

When the one-shot service is inactive, back up the host-visible data directory with your normal backup system, for example:

```bash
sudo tar -C /var/lib -czf /var/backups/ai-news-assistant-$(date +%F).tar.gz ai-news-assistant
```

Re-enable the timer afterward:

```bash
sudo systemctl start ai-news-assistant-run.timer
```

Operational checks:

```bash
systemctl status ai-news-assistant-serve.service
systemctl status ai-news-assistant-run.timer
journalctl -u ai-news-assistant-run.service -n 200 --no-pager
sudo docker compose --env-file /opt/ai-news-assistant/.env -f /opt/ai-news-assistant/compose.yaml -f /opt/ai-news-assistant/ops/homelab/compose.yaml logs --tail=200 app
```

The HTTP endpoint has no built-in authentication. Bind it only to a trusted LAN address, or to `127.0.0.1` when another private-access layer is used. Do not expose port 8787 directly to the public internet.
