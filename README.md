# AI News Assistant

A personal, self-hosted morning news pipeline that discovers stories, extracts readable content, uses an LLM to summarize and rank it, builds a daily EPUB, and exposes the latest edition for an e-reader.

The first MVP intentionally supports one source: **Meduza RSS**. Every downstream component is separated so generic RSS, Telegram, Reddit, authenticated web sources, local/cloud LLM routing, and Kindle Scribe sync can be added incrementally.

## Pipeline

```text
Meduza RSS
   -> discover
   -> fetch + Readability extraction
   -> SQLite persistence / content-hash dedupe
   -> per-article LLM analysis
   -> editorial LLM selection
   -> Pandoc EPUB3
   -> /daily/latest.json + /daily/latest.epub
```

## Supported runtime

- Node.js 22 or newer
- npm 10 or newer
- SQLite build prerequisites needed by `better-sqlite3`
- Pandoc available as `pandoc`
- An OpenAI-compatible `/v1/chat/completions` endpoint

The LLM endpoint can be a cloud API or a local service such as Ollama/llama.cpp/vLLM, as long as it exposes a compatible chat-completions endpoint.

## Docker / Compose runtime

For a Linux home server, Docker Compose is the simplest supported deployment path. The host needs Docker Engine with the Compose plugin; Node.js, npm, native npm build tools, and Pandoc are provided by the image. The same image runs all existing CLI commands: `serve`, `run`, and `doctor`.

Create the local configuration first and set at least `LLM_MODEL` plus the endpoint/key needed by your provider:

```bash
cp .env.example .env
$EDITOR .env
```

Build the image and validate its runtime dependencies:

```bash
docker compose build
docker compose run --rm app doctor
```

Start the long-running delivery service and inspect health from the host:

```bash
docker compose up -d
curl -fsS http://127.0.0.1:8787/healthz
```

By default Compose publishes port `8787` on all host interfaces. `AI_NEWS_BIND_ADDRESS` and `AI_NEWS_HTTP_PORT` in `.env` control only the host-side publish address/port; the container itself always listens on `0.0.0.0:8787`. For example, use `AI_NEWS_BIND_ADDRESS=127.0.0.1` when access should remain host-local. The delivery endpoint has no built-in authentication, so do not expose it directly to the public internet.

Run one edition manually with the same image, configuration, and persistent data:

```bash
docker compose run --rm app run
```

Compose stores all application state in the `ai-news-data` named volume mounted at `/app/data`. Inside Docker, `DATA_DIR` is forced to `/app/data` and `OUTPUT_DIR` to `/app/data/public/daily`; host values for those two variables are intentionally overridden. The volume contains `news.sqlite`, article/analysis history, `run-status.json`, build/retention state, dated EPUBs, `latest.epub`, and `latest.json`. Recreating the `app` container or running `docker compose down` does not remove that volume. Do not use `docker compose down -v` unless you intentionally want to delete all persisted application data.

If an OpenAI-compatible LLM runs directly on the Linux Docker host, container loopback cannot reach it. The Compose file maps `host.docker.internal` to Docker's host gateway, so configure:

```dotenv
LLM_BASE_URL=http://host.docker.internal:11434
```

For OpenAI or another cloud endpoint, keep the normal HTTPS URL; no special Docker networking is required.

Common lifecycle commands are:

```bash
docker compose restart app
docker compose stop
docker compose start
docker compose down
```

A repeatable container smoke test is also available for development/CI. It builds the image unless `AI_NEWS_SKIP_BUILD=1`, runs `doctor` with a dummy model, verifies Pandoc and non-root execution, starts Compose on an ephemeral localhost port, checks `/healthz`, and verifies data survives container recreation without making paid LLM calls:

```bash
npm run docker:smoke
```

For the low-resource home-lab deployment, build and validate the image on a stronger machine, export it with `docker save`, transfer it over the trusted LAN, and run only the preloaded image on the server. See [`ops/systemd/README.md`](ops/systemd/README.md) for the complete local-image transfer, bind-mounted storage, systemd scheduling, update, backup, and rollback workflow.

## Local development setup

```bash
npm ci
cp .env.example .env
```

For local development, the CLI automatically loads `.env` from the current working directory using Node.js' built-in environment-file support. Existing environment variables are not overwritten, so production and systemd deployments can continue to provide settings with `Environment=`, `EnvironmentFile=`, or another service-level mechanism without relying on `.env`.

At minimum, set an LLM model before running the pipeline or the doctor command:

```dotenv
LLM_BASE_URL=http://127.0.0.1:11434
LLM_MODEL=your-model-name
```

For a cloud provider, also set `LLM_API_KEY`. OpenAI Chat Completions can be used with conventional models or GPT-5-family models, for example:

```dotenv
LLM_BASE_URL=https://api.openai.com
LLM_MODEL=gpt-4.1-mini
```

or:

```dotenv
LLM_BASE_URL=https://api.openai.com
LLM_MODEL=gpt-5-mini
```

The provider keeps conventional OpenAI-compatible/local request behavior (`temperature` plus `max_tokens`). For GPT-5-family model names it omits legacy sampling fields such as `temperature`/`top_p` and maps `LLM_MAX_OUTPUT_TOKENS` to `max_completion_tokens`. Structured JSON behavior remains prompt-driven and runtime-validated for both article analysis and editorial selection, so local servers are not required to implement an additional `response_format` feature.

Logs are structured JSON and redact API-key, token, secret, cookie, password, and authorization fields. Remote LLM HTTP errors include bounded sanitized diagnostics such as the status, model, error type/code/parameter, and remote message without logging request headers or prompts. Set `LOG_LEVEL` to `debug`, `info`, `warn`, or `error`; the default is `info`.

Validate a checkout before running news ingestion:

```bash
npm run check
npm run dev -- doctor
```

`doctor` does not fetch news. It verifies that the configured data and output directories are writable, that the LLM settings needed by `run` are present, and that Pandoc is available on `PATH`.

## Meduza ingestion

Meduza discovery is RSS-only. Feed and article requests use the same bounded timeout/retry policy, and article downloads are intentionally sequential with a small delay between requests. URL variants are normalized before discovery deduplication, while extraction prefers the page's canonical Meduza URL and publication metadata when available.

The defaults in `.env.example` are conservative for a personal morning run:

```dotenv
MEDUZA_RSS_URL=https://meduza.io/rss/all
HTTP_USER_AGENT="ai-news-assistant/0.1 (+personal self-hosted reader)"
HTTP_TIMEOUT_MS=20000
HTTP_RETRIES=2
HTTP_RETRY_BASE_DELAY_MS=500
ARTICLE_FETCH_DELAY_MS=250
MIN_ARTICLE_CHARS=200
```

Transient network errors and HTTP 408/425/429/5xx responses are retried with bounded exponential backoff. Permanent HTTP failures and pages that do not yield enough article text are logged with their failure stage and skipped so one bad article does not abort an otherwise successful edition.

## Storage and repeat runs

SQLite schema changes are applied as numbered migrations recorded in `schema_migrations`. The current article row remains the fast lookup surface, while immutable `article_versions` rows retain each distinct `(normalized URL, content hash)` version. Re-fetching unchanged content creates no new version and reuses existing analysis; changed content creates one new history row and invalidates the stale analysis in the same transaction.

Edition membership is stored relationally as well as in the existing edition plan JSON so article/edition lookups can be indexed. Source checkpoints are monotonic and, when a run has failed items, advance only as far as the earliest failed publication timestamp. That keeps failed or undiscovered items eligible for the next RSS run instead of permanently skipping them.

## LLM article analysis

Per-article analysis uses the same OpenAI-compatible interface for local endpoints with no API key and cloud endpoints with an API key. Model output is parsed as JSON and then validated against a strict runtime schema before it can be persisted. Malformed output and transient/timeout failures are retried with bounded exponential backoff; non-transient request errors fail immediately.

The article prompt and analysis schema have explicit versions. Cached analysis is reused only when the article content is unchanged and the configured model, prompt version, and analysis version all match. Changing the prompt/schema version therefore deliberately causes re-analysis without changing article storage.

Long article text is bounded deterministically using Unicode grapheme boundaries: the prompt preserves the beginning and end and inserts an explicit omission marker in the middle. `LLM_TEMPERATURE` applies to conventional models; GPT-5-family Chat Completions intentionally omit that field. `LLM_MAX_OUTPUT_TOKENS` is sent using the token-limit field appropriate to the model family. Configure the LLM boundary with:

```dotenv
LLM_TEMPERATURE=0.2
LLM_MAX_OUTPUT_TOKENS=1200
LLM_TIMEOUT_MS=120000
LLM_RETRIES=2
LLM_RETRY_BASE_DELAY_MS=500
LLM_ARTICLE_MAX_CHARS=28000
```

Successful analysis rows record the model name, prompt and analysis versions, total LLM latency, and prompt/completion/total token counts when the provider reports them. Retry attempts that returned malformed model output are included in the persisted token totals. API keys are used only to construct request authorization headers; they are neither included in analysis metadata nor written to SQLite.

## Editorial selection

The second-pass editor receives article metadata and validated analyses only: ids, source, titles, publication times, topics, summaries, reasons, key facts, importance, and recommendation status. Raw article bodies and HTML are never included in the editorial prompt. The editorial response is strictly validated; unknown ids, duplicate ids, empty or over-limit selections, topic-cap violations, near-duplicate coverage, malformed JSON, or a provider failure all trigger the deterministic fallback instead of being silently repaired.

`EDITION_MAX_ARTICLES` remains the overall story limit. `EDITORIAL_MAX_PER_TOPIC` controls topic balance and defaults to 3 (or the edition limit when that is smaller):

```dotenv
EDITION_MAX_ARTICLES=10
EDITORIAL_MAX_PER_TOPIC=3
EDITION_LANGUAGE=ru
```

The fallback ranks stories deterministically using importance, recommendation status, and freshness, then applies the same topic balance and lightweight same-source duplicate avoidance. Its overview is assembled from already validated article summaries, so it remains readable even when the editorial model is unavailable; Russian editions receive a Russian morning lead-in. Each saved edition records the configured editorial model, editorial prompt version, and whether selection came from the LLM or fallback.

## EPUB rendering

The EPUB renderer builds a newspaper-style hierarchy with a Morning Brief, Top Stories, repeated-topic sections when useful, and Other Headlines for the remaining selected stories. Each story includes source attribution, publication time, estimated reading time, summary, importance context, key facts, and the original source URL. `INCLUDE_FULL_ARTICLES` continues to control whether sanitized article text is embedded after the summary.

Rendering assets live under `src/rendering/assets/`: monochrome-friendly CSS controls typography and page breaks, while a metadata file supplies the stable author/publisher identity. Every EPUB carries a title, edition date, language, publisher/author, and deterministic `urn:ai-news-assistant:edition:YYYY-MM-DD` identifier. Pandoc is run with `SOURCE_DATE_EPOCH` pinned to the edition date so identical input produces identical EPUB bytes.

The initial image policy is deliberately **no images**. The renderer never downloads or embeds remote images, keeping morning editions offline-friendly, compact, and predictable on e-ink devices. A future renderer may add one bounded lead image per selected article without changing the renderer interface.

Pandoc writes only to a staging directory. The staged file must exist and be non-empty before any public file is replaced; dated EPUBs, `latest.epub`, and `latest.json` are then published through same-directory temporary files plus atomic renames. A failed Pandoc invocation or missing/empty output therefore leaves the previous `latest.epub` untouched. `latest.json` records the EPUB hash, renderer version, image policy, language, identifier, story count, and full-text policy. The pipeline depends on the `EditionRenderer` abstraction, with `PandocEpubRenderer` as the default implementation.

## Run one morning edition

```bash
npm run dev -- run
```

Only one pipeline run can hold the `DATA_DIR/pipeline.lock` file at a time. A second concurrent `run` logs that another run is active and exits successfully without fetching or generating duplicate work. Stale lock files left by a dead process are recovered automatically.

After a successful run, dated EPUBs and build directories are pruned according to:

```dotenv
EDITION_RETENTION_DAYS=30
BUILD_RETENTION_DAYS=7
```

Retention never removes `news.sqlite` or its article/analysis history, and cleanup failures do not invalidate an otherwise successful edition.

Expected outputs:

```text
data/news.sqlite
data/run-status.json
data/public/daily/YYYY-MM-DD.epub
data/public/daily/latest.epub
data/public/daily/latest.json
```

## Serve the latest edition

```bash
npm run dev -- serve
```

Endpoints:

```text
GET /healthz
GET /daily/latest.json
GET /daily/latest.epub
```

`/healthz` reports safe operational state: delivery-server health, whether the latest EPUB/manifest are present, the latest edition date, last successful pipeline timestamp, last attempt status, and a safe failure code. A failed morning run marks health as degraded while the HTTP service remains available to serve the previous successful `latest.epub`.

The server accepts `SIGTERM`/`SIGINT` and stops accepting requests gracefully before exiting. Default bind is `0.0.0.0:8787`; for deployment, prefer a private LAN address or firewall-restricted LAN exposure.

## Home-server operations

The production home-lab path uses Docker Compose rather than host Node.js. The weak server runs only prebuilt, locally transferred images; it does not build or pull application images.

Build and validate a clean Git revision on the stronger machine:

```bash
./scripts/build-deployment-image.sh
```

Transfer the resulting `artifacts/ai-news-assistant-<git-sha>.tar.gz` over SSH and load it on the server:

```bash
./scripts/transfer-deployment-image.sh \
  artifacts/ai-news-assistant-<git-sha>.tar.gz \
  homelab
```

The production override [`ops/homelab/compose.yaml`](ops/homelab/compose.yaml) uses a host-visible persistent directory (default `/var/lib/ai-news-assistant`) and refuses registry pulls. The long-running delivery service starts with `up -d --no-build`; scheduled/manual one-shot commands use `run --rm --pull never` because Compose `run` does not provide a `--no-build` option.

The normal local LLM is a separate LAN service, for example:

```dotenv
LLM_BASE_URL=http://gaming-rig.home.arpa:11434
LLM_MODEL=your-model-name
```

The LLM host must listen on a LAN-reachable interface and allow the server through its firewall. If that machine is unavailable, a generation attempt may fail, but the existing degraded-health behavior keeps the previous successful `latest.epub` available.

Docker-aware systemd examples live in [`ops/systemd/`](ops/systemd/). The existing timer still schedules generation from 06:00 with up to 30 minutes randomized delay, and every run shares the same bind-mounted `pipeline.lock`, SQLite database, status file, and EPUB directory.

See [`ops/systemd/README.md`](ops/systemd/README.md) for the full first-install, local image transfer/load, permissions, systemd setup, update, rollback, backup, logging, LAN exposure, and manual image-cleanup procedures.

Do not expose the unauthenticated delivery port directly to the public internet.

## Project layout

```text
src/
  sources/       source adapters and discovery
  extraction/    article download/readability cleanup
  storage/       SQLite persistence and dedupe
  llm/           provider boundary and prompts
  rendering/     EPUB generation
  delivery/      local HTTP delivery
  operations/    run locking, status, and retention
ops/systemd/     home-server service/timer examples
plans/           MVP summary and completed task archive
tests/           lightweight Node test runner tests
```

## Current limitations

This remains a focused personal-server service rather than a general hosted news platform. Broader integration tests, additional source adapters, source-specific compliance work, and device-specific sync remain separate tasks. Keep downloaded full text private and only ingest content your accounts are authorized to access.

## MVP status

The server MVP is complete and tested. See [`plans/MVP-SUMMARY.md`](plans/MVP-SUMMARY.md) for a concise implementation summary; the original completed task specifications are retained under [`plans/completed/`](plans/completed/) as historical implementation records.
