# Task 12 — Publish multi-architecture images to GHCR

## Goal

Make home-lab installation and updates independent of local application builds by publishing tested Docker images to GitHub Container Registry.

Target image:

```text
ghcr.io/abavelski/ai-news-assistant
```

Support common Linux home-lab architectures:

- `linux/amd64`
- `linux/arm64`

## Prerequisite

Complete Task 10 first. Task 11 should already be capable of using an image reference instead of requiring a local build.

## Required changes

### 1. Add a GitHub Actions container workflow

Add a workflow under `.github/workflows/` that:

- checks out the repository,
- sets up the required Node toolchain for normal tests,
- runs `npm ci`,
- runs `npm run check`,
- sets up Docker Buildx,
- authenticates to GHCR using GitHub-provided credentials,
- builds the production image,
- publishes `linux/amd64` and `linux/arm64` manifests.

Do not use a personal access token committed to the repository.

Use the minimum workflow permissions needed, including package write access only for the publish job.

### 2. Define predictable tags

Publish immutable and human-friendly tags.

At minimum:

- commit SHA tag for published builds,
- version tag for versioned releases/tags,
- `latest` only from the intended stable/default-branch or release path.

Do not let pull requests overwrite `latest`.

Prefer OCI image labels with repository URL, revision, and source metadata.

### 3. Separate validation from publishing

Pull requests should be able to validate the Docker build without pushing an image.

Publishing should occur only on explicitly chosen events such as:

- pushes to `main`, and/or
- version tags/releases.

The workflow must not expose registry credentials to untrusted PR code.

### 4. Multi-architecture compatibility

Confirm the image builds for both amd64 and arm64.

Pay particular attention to:

- `better-sqlite3` native installation,
- Debian/runtime architecture availability,
- Pandoc package availability,
- any build-stage native toolchain requirements.

Do not claim arm64 support unless the workflow actually builds it successfully.

### 5. Container smoke validation

Before or as part of publishing, validate the built image without making paid external API calls.

At minimum:

- invoke `doctor` with a dummy non-empty `LLM_MODEL`,
- confirm Pandoc is present,
- confirm the application CLI starts,
- optionally start `serve` and probe `/healthz`.

The smoke test must not need a real OpenAI key.

### 6. Compose defaults and version pinning

Update deployment documentation/Compose examples so users can choose a published image tag.

Recommend pinning a version or immutable tag for stable home-lab operation rather than blindly tracking `latest`.

Document:

```text
docker compose pull
docker compose up -d
```

for upgrades and changing the image tag back for rollback.

Keep local `build: .` usage available for development or unreleased testing if useful.

### 7. Registry documentation

Document:

- GHCR image name,
- public/private pull expectations,
- supported architectures,
- available tag strategy,
- how to inspect the running image version,
- how to upgrade and roll back.

Do not include registry credentials in examples unless they are explicitly placeholders.

## Tests and validation

Run locally where possible:

```bash
npm ci
npm run check
docker build -t ai-news-assistant:test .
docker run --rm ... ai-news-assistant:test doctor
```

Validate the GitHub Actions workflow syntax.

After workflow implementation, verify a real workflow run produces:

- one multi-architecture GHCR image,
- amd64 and arm64 manifests,
- expected tags,
- successful pre-publish tests.

No automated test should make a paid OpenAI request.

## Acceptance criteria

- PRs/test branches can validate the image without publishing.
- Main/release publishing uses GitHub's built-in token/permissions.
- GHCR receives a multi-architecture amd64/arm64 image.
- Published image passes the non-paid smoke checks.
- `latest` is not published from pull requests.
- Immutable/version tags are available for rollback.
- Home-lab documentation supports `docker compose pull && docker compose up -d`.
- No long-lived registry secret is committed.
- Existing application behavior is unchanged.

## Non-goals

Do not:

- implement automatic Watchtower-style unattended updates,
- add Docker Hub publishing,
- add image signing/provenance policy unless it is trivial and does not distract from the core task,
- add Kubernetes/Helm,
- change application features.

## Suggested commit

```text
ci: publish multi-architecture GHCR images
```
