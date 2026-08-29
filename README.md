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

## Setup

```bash
npm install
cp .env.example .env
```

For local development, the CLI automatically loads `.env` from the current working directory using Node.js' built-in environment-file support. Existing environment variables are not overwritten, so production and systemd deployments can continue to provide settings with `Environment=`, `EnvironmentFile=`, or another service-level mechanism without relying on `.env`.

At minimum, set an LLM model before running the pipeline or the doctor command:

```dotenv
LLM_BASE_URL=http://127.0.0.1:11434
LLM_MODEL=your-model-name
```

For a cloud provider, also set `LLM_API_KEY`. Logs are structured JSON and redact API-key, token, secret, cookie, password, and authorization fields. Set `LOG_LEVEL` to `debug`, `info`, `warn`, or `error`; the default is `info`.

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

## Run one morning edition

```bash
npm run dev -- run
```

Expected outputs:

```text
data/news.sqlite
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

Default bind is `0.0.0.0:8787`.

## Production shape

The intended home-server deployment is two systemd units:

1. a long-running delivery server;
2. a timer that runs the pipeline around 06:00 each morning.

Task 00 keeps configuration systemd-friendly by letting service-provided environment variables take precedence over a local `.env`. The exact systemd deployment remains intentionally deferred to [`plans/06-http-delivery-scheduling.md`](plans/06-http-delivery-scheduling.md).

## Project layout

```text
src/
  sources/       source adapters and discovery
  extraction/    article download/readability cleanup
  storage/       SQLite persistence and dedupe
  llm/           provider boundary and prompts
  rendering/     EPUB generation
  delivery/      local HTTP delivery
plans/           agent-ready implementation tasks
tests/           lightweight Node test runner tests
```

## Current limitations

This remains an architectural skeleton rather than a complete production service. Before unattended use beyond the current Meduza ingestion and storage scope, add stronger schema validation of LLM output, broader integration tests, and source-specific compliance checks. Keep downloaded full text private and only ingest content your accounts are authorized to access.

## Agent task plan

Start with [`plans/README.md`](plans/README.md). Each task is written so it can be handed independently to Codex or a local coding model, with scope, acceptance criteria, tests, and non-goals.
