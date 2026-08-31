#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

for command in git docker gzip; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Required command not found: $command" >&2
    exit 1
  fi
done

if [[ -n "$(git status --porcelain --untracked-files=normal)" ]]; then
  echo "Refusing to package a dirty working tree. Commit/stash changes first." >&2
  git status --short >&2
  exit 1
fi

GIT_SHA="$(git rev-parse --short=12 HEAD)"
IMAGE_REPOSITORY="${AI_NEWS_IMAGE_REPOSITORY:-ai-news-assistant}"
IMAGE="${IMAGE_REPOSITORY}:${GIT_SHA}"
PLATFORM="${AI_NEWS_PLATFORM:-linux/amd64}"
ARTIFACT_DIR="${AI_NEWS_ARTIFACT_DIR:-$ROOT_DIR/artifacts}"
ARTIFACT="${ARTIFACT_DIR}/ai-news-assistant-${GIT_SHA}.tar.gz"
CHECKSUM_FILE="${ARTIFACT}.sha256"
TMP_ARTIFACT="${ARTIFACT}.tmp"

mkdir -p "$ARTIFACT_DIR"
rm -f "$ARTIFACT" "$CHECKSUM_FILE" "$TMP_ARTIFACT"

echo "Building ${IMAGE} for ${PLATFORM}..."
docker build --platform "$PLATFORM" --target runtime -t "$IMAGE" "$ROOT_DIR"

echo "Running non-paid container smoke validation..."
AI_NEWS_IMAGE="$IMAGE" AI_NEWS_SKIP_BUILD=1 "$ROOT_DIR/scripts/docker-smoke.sh"

ACTUAL_PLATFORM="$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$IMAGE")"
if [[ "$ACTUAL_PLATFORM" != "$PLATFORM" ]]; then
  echo "Built image platform ${ACTUAL_PLATFORM} does not match requested ${PLATFORM}." >&2
  exit 1
fi

echo "Exporting ${IMAGE}..."
docker save "$IMAGE" | gzip -n > "$TMP_ARTIFACT"
mv "$TMP_ARTIFACT" "$ARTIFACT"

if command -v sha256sum >/dev/null 2>&1; then
  CHECKSUM="$(sha256sum "$ARTIFACT" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
  CHECKSUM="$(shasum -a 256 "$ARTIFACT" | awk '{print $1}')"
else
  echo "Neither sha256sum nor shasum is available." >&2
  exit 1
fi

printf '%s  %s\n' "$CHECKSUM" "$(basename "$ARTIFACT")" > "$CHECKSUM_FILE"

echo
echo "Deployment image ready:"
echo "  image:    $IMAGE"
echo "  platform: $ACTUAL_PLATFORM"
echo "  archive:  $ARTIFACT"
echo "  checksum: $CHECKSUM_FILE"
