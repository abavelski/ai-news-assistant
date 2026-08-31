# Task 03 — Reliable LLM summarization layer

## Agent prompt

Make per-article analysis reliable across OpenAI-compatible cloud and local endpoints, with strict structured output validation, bounded prompts, retries, and cost/token observability.

## Goals

- Support a local or cloud OpenAI-compatible model through the same interface.
- Never trust unvalidated model JSON.
- Keep prompts within predictable limits for long articles.
- Reuse cached analysis for unchanged content.

## Work

- Add a runtime schema validator for article-analysis output.
- Add bounded retries for malformed JSON and transient LLM failures.
- Add configurable model parameters and request timeout.
- Implement deterministic article text truncation/chunking strategy. Preserve beginning/end and avoid silently cutting in the middle of Unicode sequences.
- Record model name, prompt version, analysis version, latency, and token usage where the endpoint reports it.
- Version prompts so changing a prompt can deliberately trigger re-analysis.
- Add tests with a fake LLM provider covering valid JSON, fenced JSON, malformed JSON, retry, and timeout.

## Acceptance criteria

- Invalid model output cannot be persisted as valid analysis.
- Unchanged article + same prompt/model analysis version is cached.
- Local providers with no API key remain supported.
- Cloud API keys never appear in logs or database rows.
- `npm run check` passes.

## Non-goals

No embeddings, personalization, or cross-story clustering yet.

## Suggested commit

`feat: validate and cache article LLM analysis`
