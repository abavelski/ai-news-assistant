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

## Requirements

- Node.js 22+
- npm
- SQLite build prerequisites needed by `better-sqlite3`
- Pandoc available as `pandoc`
- An OpenAI-compatible `/v1/chat/completions` endpoint

The LLM endpoint can be a cloud API or a local service such as Ollama/llama.cpp/vLLM, as long as it exposes a compatible chat-completions endpoint.

## Setup

```bash
npm install
cp .env.example .env
```

This skeleton deliberately does not depend on an environment-file loader. Export variables in your shell/systemd unit, source `.env` before running, or add `dotenv` in a later task.

At minimum set:

```bash
export LLM_BASE_URL=http://127.0.0.1:11434
export LLM_MODEL='your-model-name'
```

For a cloud provider, also set `LLM_API_KEY`.

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

The exact systemd deployment is intentionally left as an implementation task in [`plans/06-http-delivery-scheduling.md`](plans/06-http-delivery-scheduling.md).

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

This is an architectural skeleton, not a production-ready scraper. Before unattended use, add retries/backoff, stronger schema validation of LLM output, extraction fixtures, integration tests, observability, rate limiting, and source-specific compliance checks. Keep downloaded full text private and only ingest content your accounts are authorized to access.

## Agent task plan

Start with [`plans/README.md`](plans/README.md). Each task is written so it can be handed independently to Codex or a local coding model, with scope, acceptance criteria, tests, and non-goals.
