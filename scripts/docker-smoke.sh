#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${AI_NEWS_IMAGE:-ai-news-assistant:test}"
PROJECT="${AI_NEWS_SMOKE_PROJECT:-ai-news-assistant-smoke-$$}"
ENV_FILE="$(mktemp)"

cleanup() {
  AI_NEWS_IMAGE="$IMAGE" \
  AI_NEWS_ENV_FILE="$ENV_FILE" \
  AI_NEWS_BIND_ADDRESS=127.0.0.1 \
  AI_NEWS_HTTP_PORT=0 \
  COMPOSE_PROJECT_NAME="$PROJECT" \
    docker compose -f "$ROOT_DIR/compose.yaml" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -f "$ENV_FILE"
}
trap cleanup EXIT

cat > "$ENV_FILE" <<'ENVEOF'
LOG_LEVEL=info
LLM_BASE_URL=http://host.docker.internal:11434
LLM_MODEL=smoke-test-model
LLM_API_KEY=
ENVEOF

if [[ "${AI_NEWS_SKIP_BUILD:-0}" != "1" ]]; then
  docker build -t "$IMAGE" "$ROOT_DIR"
fi

docker run --rm --entrypoint node "$IMAGE" -e \
  "if (typeof process.getuid !== 'function' || process.getuid() === 0) { process.exit(1); }"

docker run --rm --entrypoint sh "$IMAGE" -c \
  'command -v pandoc >/dev/null && pandoc --version | head -n 1'

compose() {
  AI_NEWS_IMAGE="$IMAGE" \
  AI_NEWS_ENV_FILE="$ENV_FILE" \
  AI_NEWS_BIND_ADDRESS=127.0.0.1 \
  AI_NEWS_HTTP_PORT=0 \
  COMPOSE_PROJECT_NAME="$PROJECT" \
    docker compose -f "$ROOT_DIR/compose.yaml" "$@"
}

compose config >/dev/null
compose run --rm app doctor
compose up -d --no-build app

published="$(compose port app 8787 | tail -n 1)"
port="${published##*:}"
if [[ -z "$port" || "$port" == "$published" ]]; then
  echo "Could not determine published healthcheck port from: $published" >&2
  exit 1
fi

healthy=0
for _ in $(seq 1 30); do
  if node -e \
    "fetch('http://127.0.0.1:${port}/healthz').then(async r => { const b = await r.json(); process.exit(r.ok && b.ok === true ? 0 : 1); }).catch(() => process.exit(1))"; then
    healthy=1
    break
  fi
  sleep 1
done
if [[ "$healthy" != "1" ]]; then
  compose logs app >&2 || true
  echo "Container health endpoint did not become ready." >&2
  exit 1
fi

compose exec -T app node -e \
  "require('node:fs').writeFileSync('/app/data/docker-smoke-persist.txt', 'persistent')"
compose rm -sf app >/dev/null
compose up -d --no-build app
compose exec -T app node -e \
  "const fs = require('node:fs'); if (fs.readFileSync('/app/data/docker-smoke-persist.txt', 'utf8') !== 'persistent') process.exit(1)"
compose exec -T app node -e \
  "if (typeof process.getuid !== 'function' || process.getuid() === 0) process.exit(1)"

echo "Docker smoke checks passed."
