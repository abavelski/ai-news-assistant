#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 <ai-news-assistant-<git-sha>.tar.gz> <ssh-host> [remote-dir]" >&2
  exit 2
}

[[ $# -ge 2 && $# -le 3 ]] || usage

ARTIFACT="$1"
REMOTE="$2"
REMOTE_DIR="${3:-/tmp}"
CHECKSUM_FILE="${ARTIFACT}.sha256"

[[ -f "$ARTIFACT" ]] || { echo "Image archive not found: $ARTIFACT" >&2; exit 1; }
[[ -f "$CHECKSUM_FILE" ]] || { echo "Checksum file not found: $CHECKSUM_FILE" >&2; exit 1; }

ARCHIVE_NAME="$(basename "$ARTIFACT")"
CHECKSUM_NAME="$(basename "$CHECKSUM_FILE")"

if [[ ! "$ARCHIVE_NAME" =~ ^ai-news-assistant-[0-9a-f]{12}\.tar\.gz$ ]]; then
  echo "Unexpected archive name: $ARCHIVE_NAME" >&2
  exit 1
fi

if [[ ! "$REMOTE_DIR" =~ ^/[A-Za-z0-9._/-]+$ ]]; then
  echo "Remote directory must be an absolute path containing only letters, digits, '.', '_', '-', and '/': $REMOTE_DIR" >&2
  exit 1
fi

REMOTE_COMMAND="set -euo pipefail; cd '$REMOTE_DIR'; sha256sum -c '$CHECKSUM_NAME'; gzip -dc '$ARCHIVE_NAME' | docker load; rm -f '$ARCHIVE_NAME' '$CHECKSUM_NAME'"

if [[ "${AI_NEWS_TRANSFER_DRY_RUN:-0}" == "1" ]]; then
  printf 'scp %q %q %q\n' "$ARTIFACT" "$CHECKSUM_FILE" "${REMOTE}:${REMOTE_DIR}/"
  printf 'ssh %q %q\n' "$REMOTE" "$REMOTE_COMMAND"
  exit 0
fi

for command in scp ssh; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Required command not found: $command" >&2
    exit 1
  fi
done

echo "Transferring $ARCHIVE_NAME to ${REMOTE}:${REMOTE_DIR}/ ..."
scp "$ARTIFACT" "$CHECKSUM_FILE" "${REMOTE}:${REMOTE_DIR}/"

echo "Verifying and loading image on $REMOTE ..."
ssh "$REMOTE" "$REMOTE_COMMAND"

echo "Image loaded successfully; transferred archive removed from $REMOTE."
echo "Older Docker image tags were intentionally left untouched for rollback."
