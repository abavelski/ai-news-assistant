# Task 08 — Additional source adapters

## Agent prompt

Expand ingestion one source at a time while preserving the common normalized article/post model. Prefer official feeds/APIs and authenticated access that the user's own account is allowed to use. Do not make downstream code source-aware.

## Recommended sequence

1. Generic RSS/Atom.
2. Reddit through an official/authenticated API or user-approved integration.
3. Telegram channels available to the user's account, using an authorized client/session.
4. Generic public websites with site adapters.
5. X/Facebook only after evaluating current official API/account-access options and terms.

## Work for each adapter

- Implement `NewsSource` discovery and source-specific fetch/normalize logic.
- Add source configuration and credentials through secret-safe environment/config mechanisms.
- Add stable external IDs and canonical URLs.
- Add rate limits, retry behavior, and checkpoint semantics.
- Preserve post/thread/comment structure when it adds value instead of flattening everything into fake articles.
- Add fixtures and tests before enabling the adapter in production configuration.
- Document what is downloaded and what authorization is required.

## Acceptance criteria

- Adding a source requires no changes to LLM, editorial, rendering, or delivery interfaces except explicit handling of a new normalized content type if needed.
- Credentials never enter logs, EPUB metadata, or git.
- The system does not bypass access controls/paywalls/DRM.
- Every adapter has offline fixture tests.

## Non-goals

Do not implement all social platforms in one change. One adapter per reviewed commit is preferred.

## Suggested commit pattern

`feat(source): add <source-name> adapter`
