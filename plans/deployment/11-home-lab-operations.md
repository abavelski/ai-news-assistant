# Task 11 — Local-build home-lab deployment and scheduling

## Goal

Turn the Docker runtime from Task 10 into the actual home-lab deployment workflow:

1. pull/update the public Git repository on a stronger build machine,
2. build and validate the Docker image there,
3. export the image as a local artifact,
4. transfer it over the trusted LAN to the weak Lenovo home server,
5. load and run that exact image on the server with Docker Compose,
6. keep the existing systemd morning schedule on the server.

The Docker image is **not published to a registry**. The Git repository is the only published distribution artifact.

The home server should not compile the application or run the LLM. It should only run Docker/Compose, store persistent application data, serve the generated EPUB, and trigger scheduled one-shot runs.

## Prerequisite

Complete Task 10 first and use its image/Compose contract rather than creating another runtime mechanism.

## Target topology

```text
Strong build machine / gaming rig
├── git pull --ff-only
├── docker build
├── container smoke validation
└── docker save -> compressed image artifact
                    │
                    │ SCP/SSH over trusted LAN
                    ▼
Weak Lenovo home server
├── Docker Engine + Compose
├── loaded ai-news-assistant:<git-sha> image
├── long-running `serve` container
├── temporary `run` / `doctor` containers
├── persistent application data
└── systemd morning timer

Gaming rig / LLM machine when powered on
└── OpenAI-compatible LLM endpoint on the LAN
        ▲
        └── home-server container connects by LAN IP/DNS name
```

The build machine and Lenovo are expected to be `linux/amd64`. Do not add multi-architecture publishing infrastructure merely for this deployment. If the target architecture changes later, handle that as a separate requirement.

## Read first

Inspect:

- `Dockerfile`
- `compose.yaml`
- `.env.example`
- `scripts/docker-smoke.sh`
- `ops/systemd/README.md`
- `ops/systemd/ai-news-assistant-serve.service`
- `ops/systemd/ai-news-assistant-run.service`
- `ops/systemd/ai-news-assistant-run.timer`
- `src/operations/run-lock.ts`
- `src/operations/status.ts`
- `src/operations/retention.ts`

Preserve the existing run-lock, status, health, retention, and failed-run behavior.

## Required changes

### 1. Define a reproducible local image identity

Tag deployable images with the Git commit that produced them, for example:

```bash
GIT_SHA="$(git rev-parse --short=12 HEAD)"
docker build -t "ai-news-assistant:${GIT_SHA}" .
```

The deployed server configuration must make it obvious which immutable local tag is running.

Do not rely on an ambiguous locally moving `latest` tag for rollback.

### 2. Add a build/export workflow on the strong machine

Provide a small script or documented command sequence that:

- requires a clean/known Git revision,
- builds the production image,
- runs the existing non-paid Docker smoke validation,
- exports the exact tagged image with `docker save`,
- optionally compresses the artifact,
- prints the resulting tag/file clearly.

Example shape:

```bash
docker save "ai-news-assistant:${GIT_SHA}" | gzip > "ai-news-assistant-${GIT_SHA}.tar.gz"
```

Do not require a container registry or a GitHub package/release upload.

### 3. Transfer and load the image over the LAN

Document and preferably script the trusted-LAN deployment flow using normal SSH/SCP tooling, for example:

```bash
scp "ai-news-assistant-${GIT_SHA}.tar.gz" homelab:/tmp/
ssh homelab "gunzip -c /tmp/ai-news-assistant-${GIT_SHA}.tar.gz | docker load"
```

Clean up transferred image archives after a successful load so the weak server does not accumulate large tarballs.

Do not delete older Docker image tags automatically if they may be needed for rollback; document an explicit cleanup command instead.

### 4. Make Compose deploy without building on the Lenovo

The home-server update/start path must use an already loaded image and must not trigger a local build.

Use the existing `AI_NEWS_IMAGE` mechanism or an equivalent explicit image variable and deploy with commands such as:

```bash
docker compose up -d --no-build
```

The Lenovo may keep a lightweight Git checkout under `/opt/ai-news-assistant` for `compose.yaml`, scripts, and systemd integration, but normal production updates must not run `docker compose build` there.

Document a safe way to update that checkout (`git pull --ff-only`) independently from loading the image.

### 5. Keep persistent data explicit

Use one stable persistent location for all application state. Prefer a host-visible bind mount for the final home-server deployment so backup and inspection are straightforward, for example:

```text
/var/lib/ai-news-assistant/
  news.sqlite
  run-status.json
  builds/
  public/daily/
```

If Task 10's named volume remains the default development setup, add a home-lab Compose override or equivalent deployment configuration for the bind mount rather than weakening the general Compose contract.

Make UID/GID ownership explicit for the non-root container user. Avoid `chmod 777`.

Container replacement, image changes, and rollback must not remove this directory.

### 6. Make systemd operate Docker Compose

Update the host-side units so production systemd does not invoke host Node.js.

The desired model is:

- Compose/restart policy keeps `serve` running,
- the morning one-shot service runs the already loaded image with:

```text
docker compose run --rm --pull never app run
```

- the existing timer starts that service each morning.

Do not run cron or systemd inside the container.

Keep the existing ~06:00 randomized morning schedule unless there is a specific operational reason to change it.

### 7. Configure the LLM as a separate LAN service

The normal local-LLM topology is **not** an LLM on the Lenovo Docker host. It is an OpenAI-compatible service on another LAN machine, normally the gaming rig when it is powered on.

Document configuration such as:

```dotenv
LLM_BASE_URL=http://gaming-rig.home.arpa:11434
LLM_MODEL=your-model-name
```

or, when local DNS is unavailable:

```dotenv
LLM_BASE_URL=http://192.168.1.50:11434
```

Recommend a DHCP reservation or stable local DNS name for the gaming rig. The LLM service must listen on an address reachable from the LAN, and the gaming-rig firewall must permit the home server to reach the chosen port.

No special Docker `host-gateway` mapping is required for this cross-machine LAN path; ordinary container outbound networking should reach the LAN address. Keep cloud OpenAI endpoints working normally as well.

If the gaming rig is off or the LLM is unreachable, the morning run may fail. Preserve the existing behavior where the previous successful `latest.epub` remains available and health reports degradation rather than destroying the previous edition.

Wake-on-LAN orchestration is explicitly deferred to a future task.

### 8. Add install/update/rollback procedures

Document the first install on the Lenovo:

1. install Docker Engine + Compose plugin and SSH access,
2. clone/place the repository deployment checkout,
3. create `/var/lib/ai-news-assistant` with correct ownership,
4. create `.env` on the server without committing secrets,
5. transfer/load a validated image from the strong machine,
6. set `AI_NEWS_IMAGE` to that immutable local tag,
7. run `doctor` with `--pull never`,
8. start `serve` with `--no-build`,
9. install/enable the systemd timer,
10. verify `/healthz` and one manual generation when the LLM is available.

Document the normal update workflow as two explicit sides:

**Build machine:**

```text
git pull --ff-only
build + smoke-test image
save/compress image
scp image to Lenovo
```

**Lenovo:**

```text
git pull --ff-only              # deployment files only
docker load                     # transferred image
set AI_NEWS_IMAGE=<new git tag>
docker compose up -d --no-build
check health/logs
```

Rollback must be possible by changing `AI_NEWS_IMAGE` back to a previously loaded Git-SHA tag and running `docker compose up -d --no-build` again. Persistent SQLite/EPUB data must stay untouched.

Include backup guidance for `/var/lib/ai-news-assistant` before risky upgrades and an explicit/manual old-image cleanup procedure.

### 9. Validate scheduling, locking, and low-resource operation

Confirm that:

- the Lenovo never needs Node.js, npm, Pandoc, or a compiler outside the image,
- normal deployment never builds the image on the Lenovo,
- `serve`, scheduled `run`, and manual `run` share the same persistent data path,
- `pipeline.lock` is visible to all one-shot containers,
- a concurrent manual run cannot duplicate a scheduled run,
- a failed/unreachable LLM run leaves the previous `latest.epub` available,
- the serve unit uses `up --no-build` and one-shot units use `run --pull never`,
- loaded image/tag identity can be inspected easily.

## Tests and validation

Run on the build machine:

```bash
npm ci
npm run check
docker build -t ai-news-assistant:test .
docker compose config
npm run docker:smoke
```

Validate the home-server unit files with:

```bash
systemd-analyze verify <docker-aware unit files>
```

Where practical, add lightweight shell validation for image export/import command construction and Compose/systemd `--no-build` usage without making a real paid LLM request.

A manual deployment smoke test should prove:

1. image is built on the strong machine,
2. image is transferred and loaded on the Lenovo,
3. `docker compose run --rm --pull never app doctor` succeeds with a dummy model,
4. `docker compose up -d --no-build` serves `/healthz`,
5. data survives container recreation,
6. switching between two locally loaded image tags does not affect persistent data.

## Acceptance criteria

- No Docker registry or image publishing is required.
- The public Git repository is the only published project artifact.
- Production images are built and validated on the stronger machine, not the Lenovo.
- Images are exported with `docker save`, transferred over the LAN, and loaded with `docker load`.
- The Lenovo deployment uses an immutable Git-SHA-derived image tag and `--no-build`.
- Morning generation remains a one-shot Compose container triggered by systemd.
- Persistent data is host-visible, backed up independently, and survives image/container replacement.
- The LLM is documented as a separate LAN endpoint on the gaming rig or another machine.
- LLM unavailability preserves the previous successful edition.
- Install, update, rollback, backup, logs, and image cleanup are documented.
- Existing application pipeline behavior is unchanged.

## Non-goals

Do not:

- publish to GHCR, Docker Hub, or any other registry,
- add GitHub Actions image publishing,
- build production images on the weak home server,
- add an in-container scheduler,
- add Kubernetes/Helm,
- add public reverse-proxy/TLS infrastructure,
- implement Wake-on-LAN yet,
- redesign the LLM/provider logic,
- change article/editorial/rendering behavior.

## Suggested commit

```text
ops: add local image transfer home-lab workflow
```
