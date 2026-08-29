# Task 07 — Kindle Scribe wake-and-sync client

## Agent prompt

Implement the Scribe-side half only after confirming the exact jailbreak/homebrew environment and KOReader installation. Build a conservative LAN sync client that checks the server manifest on wake, downloads a changed EPUB atomically, verifies SHA-256, and makes the new edition easy to open.

## Preconditions

Before coding, record in the task implementation notes:

- Scribe generation and firmware version.
- Jailbreak method/homebrew launcher available.
- KOReader version and launch mechanism.
- Writable document path.
- Available shell/runtime tools (`curl`/`wget`, `sha256sum`, launcher hooks).

Do not guess these details.

## Protocol

Server endpoints:

```text
GET /daily/latest.json
GET /daily/latest.epub
```

Manifest fields include edition, sha256, generatedAt, and URL.

## Work

- Write the smallest possible shell/script client supported by the device.
- Compare remote edition/hash to a local state file.
- Download to a temporary path.
- Verify SHA-256 before atomic rename into the final documents path.
- Leave the previous valid EPUB untouched on any failure.
- Integrate with the safest available wake/launcher hook rather than trying to keep the Kindle awake overnight.
- Optionally launch/open KOReader only if the platform integration is proven stable.
- Add logging to a small rotating text log on the device.

## Acceptance criteria

- No network/update means the existing edition remains readable.
- An interrupted/corrupt download never replaces the valid edition.
- Repeated wake events with the same hash do not redownload.
- The script contains no server/cloud credentials beyond LAN URL unless explicitly required.
- Device-specific assumptions are documented.

## Non-goals

Do not bypass Amazon account security, DRM, or access controls. Do not attempt risky firmware modification beyond the user's existing jailbreak environment.

## Suggested commit

`feat: add Kindle Scribe manifest sync client`
