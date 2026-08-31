import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("home-lab Compose override uses host persistence and never pulls images", async () => {
  const override = await fs.readFile(path.join(process.cwd(), "ops", "homelab", "compose.yaml"), "utf8");

  assert.match(override, /pull_policy:\s*never/);
  assert.match(override, /\$\{AI_NEWS_DATA_DIR:-\/var\/lib\/ai-news-assistant\}:\/app\/data/);
  assert.doesNotMatch(override, /build:/);
});

test("deployment packaging script binds image identity to a clean Git revision", async () => {
  const script = await fs.readFile(path.join(process.cwd(), "scripts", "build-deployment-image.sh"), "utf8");

  assert.match(script, /git status --porcelain/);
  assert.match(script, /git rev-parse --short=12 HEAD/);
  assert.match(script, /docker build --platform/);
  assert.match(script, /docker-smoke\.sh/);
  assert.match(script, /docker save/);
  assert.match(script, /gzip -n/);
  assert.match(script, /sha256sum|shasum/);
  assert.doesNotMatch(script, /docker (?:push|login)|ghcr\.io|docker\.io/);
});

test("LAN transfer script verifies, loads, and removes only transferred archives", async () => {
  const script = await fs.readFile(path.join(process.cwd(), "scripts", "transfer-deployment-image.sh"), "utf8");

  assert.match(script, /scp/);
  assert.match(script, /ssh/);
  assert.match(script, /sha256sum -c/);
  assert.match(script, /docker load/);
  assert.match(script, /rm -f/);
  assert.match(script, /AI_NEWS_TRANSFER_DRY_RUN/);
  assert.doesNotMatch(script, /docker image rm|docker system prune|docker (?:push|login)|ghcr\.io/);
});
