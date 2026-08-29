# Task 09 — Story clustering and personalization

## Agent prompt

After multiple sources are stable, evolve the product from a summarizer into a personal editor: cluster multiple posts/articles about one underlying story, synthesize agreements/disagreements, and rank based on explicit reader feedback rather than opaque behavioral surveillance.

## Goals

- Avoid five near-identical stories about one event.
- Surface meaningful differences between sources.
- Learn from explicit preferences and reading actions the user chooses to record.
- Keep personalization inspectable and resettable.

## Work

- Define a `story_cluster` model linking many normalized items to one event/topic.
- Start with deterministic lexical/time-window similarity; evaluate embeddings only if they materially improve quality.
- Generate a cluster synthesis that cites the included source items and separates fact from commentary.
- Add explicit feedback signals such as interesting, less like this, saved, finished, skipped.
- Build a transparent ranking score combining editorial importance, freshness, source diversity, topic preference, and novelty.
- Add a command/report that explains why an item was selected.
- Add reset/export of personalization state.

## Acceptance criteria

- Clustering is deterministic enough to test on fixtures.
- The edition can show one story with several source perspectives instead of duplicate entries.
- Ranking explanations expose the major factors used.
- Personalization can be disabled without breaking the core pipeline.
- No hidden collection of unrelated browsing/account activity is introduced.

## Non-goals

Do not build a general-purpose recommendation ad profile or collect data not needed for the private news assistant.

## Suggested commit

`feat: add explainable story clustering and preferences`
