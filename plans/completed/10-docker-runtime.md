# Task 10 — Reproducible Docker runtime and Compose packaging

## Goal

Package the existing MVP as one production Docker image that can run the existing `serve`, `run`, and `doctor` CLI commands, with Docker Compose providing the normal home-lab runtime.

This task establishes the container contract. Do not change pipeline behavior.

## Read first

Inspect:

- `package.json`
- `src/index.ts`
- `src/config.ts`
- `src/rendering/epub.ts`
- `src/rendering/assets/`
- `.env.example`
- existing tests

Confirm the compiled entry point and runtime filesystem assumptions before writing the image.

## Required changes

### 1. Add a committed npm lockfile

The repository currently has no `package-lock.json`.

Generate and commit a lockfile using the supported Node/npm toolchain. Container builds must use `npm ci`, not an unconstrained `npm install`.

Do not upgrade dependencies merely to create the lockfile unless necessary to resolve an actual build failure.

### 2. Add a multi-stage production `Dockerfile`

Use a glibc-based Node 22 image such as Debian Bookworm slim rather than Alpine, because the project uses the native `better-sqlite3` dependency.

The build stage must:

- install the native build prerequisites needed by npm dependencies when required,
- run `npm ci`,
- copy the TypeScript source/config,
- run `npm run check`,
- build the application,
- remove development-only dependencies before the runtime image is assembled, or otherwise ensure the runtime image contains production dependencies only.

The runtime stage must contain:

- Node.js 22,
- production npm dependencies,
- compiled `dist/`,
- `package.json`,
- `src/rendering/assets/`,
- Pandoc,
- CA certificates.

Run as a non-root user.

The image should use the existing CLI naturally, for example:

```text
docker run ... IMAGE serve
docker run ... IMAGE run
docker run ... IMAGE doctor
```

An `ENTRYPOINT` such as `node dist/src/index.js` with default `CMD ["serve"]` is acceptable.

Do not copy `.env`, local data, test fixtures, `.git`, or host `node_modules` into the runtime image.

### 3. Add `.dockerignore`

Exclude at minimum:

- `.git`
- `node_modules`
- `dist`
- local `.env`
- `data/`
- generated EPUB/build output
- editor/OS temporary files

Do not exclude source files or rendering assets required by the build.

### 4. Add `compose.yaml`

Provide one primary `app` service using the same image for all CLI commands.

The normal service must:

- run `serve`,
- load user configuration from `.env`,
- force container-internal `DATA_DIR` and `OUTPUT_DIR` to stable container paths,
- bind persistent application data to the host or a named volume,
- expose the HTTP port,
- use a restart policy suitable for a home server,
- use `init: true`,
- include an HTTP healthcheck against `/healthz`.

The Compose setup must allow the same service definition to be used for:

```bash
docker compose run --rm app run
docker compose run --rm app doctor
```

Do not create a permanent second scheduler container.

### 5. Handle Linux host-local LLM access

Document and configure a supported way for a container to reach an LLM server running directly on the Linux Docker host.

Prefer a Compose `host-gateway` mapping so users can configure:

```dotenv
LLM_BASE_URL=http://host.docker.internal:11434
```

Cloud OpenAI configuration must continue to work normally.

Do not change application networking logic for this; solve it at the container/Compose layer.

### 6. Persistent data contract

Document exactly which directory must persist across container replacement.

The persisted directory must retain:

- `news.sqlite`
- article/analysis history
- `run-status.json`
- build/retention state
- dated EPUBs
- `latest.epub`
- `latest.json`

Deleting/recreating the application container must not delete these files.

### 7. Documentation

Add a Docker/Compose section to the main README that covers:

- prerequisites: Docker Engine + Compose plugin,
- copying/configuring `.env`,
- building locally,
- starting the server,
- running `doctor`,
- manually running one edition,
- checking `/healthz`,
- where persistent data lives,
- reaching a host-local LLM,
- stopping/restarting the stack.

Keep the existing non-Docker development instructions available.

## Tests and validation

Run:

```bash
npm ci
npm run check
docker build -t ai-news-assistant:test .
docker compose config
```

Then perform container-level smoke tests without paid external API calls:

1. Run `doctor` with a dummy non-empty `LLM_MODEL` and writable mounted data directory. It should confirm Pandoc is installed.
2. Start `serve` with Compose.
3. Verify the health endpoint responds from the host.
4. Verify the container runs as non-root.
5. Verify a file created under the mounted data directory survives container recreation.
6. If Docker is available in CI/local validation, add a lightweight automated smoke script or test target rather than relying only on prose.

Do not require a real OpenAI API key for automated validation.

## Acceptance criteria

- `package-lock.json` is committed and `npm ci` works.
- The image builds reproducibly on the supported Node 22 toolchain.
- `npm run check` runs successfully during or before image construction.
- Pandoc is present in the runtime image.
- `serve`, `run`, and `doctor` can all be invoked from the same image.
- Runtime process is non-root.
- Compose starts the delivery service and `/healthz` responds.
- Application data is persistent outside the container.
- Host-local and cloud LLM endpoint configuration are documented.
- No secret or `.env` content is baked into the image.
- Existing non-container application behavior is unchanged.

## Non-goals

Do not:

- publish the image to a registry yet,
- move the systemd morning timer into Docker,
- add Kubernetes,
- add Traefik/Caddy/Nginx,
- redesign configuration,
- change article/editorial/rendering behavior.

## Suggested commit

```text
ops: add Docker runtime and Compose packaging
```
