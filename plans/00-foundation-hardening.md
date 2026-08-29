# Task 00 — Foundation hardening

## Agent prompt

Harden the existing Node.js/TypeScript skeleton without changing its architecture or adding product features. Make configuration, logging, errors, tests, and developer setup reliable enough for the next implementation tasks.

## Goals

- Make a clean checkout easy to configure and validate.
- Keep the app runnable with Node.js 22+.
- Fail early with actionable configuration errors.
- Establish conventions future source adapters can follow.

## Work

- Add an environment-file loading strategy suitable for local development while remaining systemd-friendly.
- Add structured logging with levels and contextual fields.
- Add explicit error classes for fetch, extraction, LLM, rendering, and configuration failures.
- Validate numeric ranges and required configuration.
- Add a `doctor` CLI command that checks writable data/output directories, LLM configuration, and Pandoc availability without doing a news run.
- Add tests for configuration parsing and `doctor` helpers.
- Document supported Node/npm versions and setup.

## Acceptance criteria

- `npm run check` passes.
- `npm run dev -- doctor` exits 0 in a correctly configured environment.
- Invalid `PORT`, empty `LLM_MODEL` for `run`, and missing Pandoc produce distinct actionable errors.
- Logging does not print API keys or authorization headers.
- No product feature beyond infrastructure hardening is introduced.

## Non-goals

Do not add new news sources, queues, Docker, Redis, vector databases, or a web UI.

## Suggested commit

`chore: harden service foundation and diagnostics`
