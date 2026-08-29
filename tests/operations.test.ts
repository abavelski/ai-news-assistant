import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseConfig } from "../src/config.js";
import { LlmError } from "../src/errors.js";
import { pruneRetention } from "../src/operations/retention.js";
import { acquirePipelineRunLock } from "../src/operations/run-lock.js";
import {
  buildDeliveryHealth,
  readRunStatus,
  recordRunFailed,
  recordRunStarted,
  recordRunSucceeded,
  runStatusPath
} from "../src/operations/status.js";

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test("pipeline run lock rejects a concurrent run and releases cleanly", async () => {
  const dataDir = await tempDir("ai-news-lock-");
  try {
    const first = await acquirePipelineRunLock(dataDir, () => new Date("2026-08-29T04:00:00Z"));
    assert.equal(first.acquired, true);
    if (!first.acquired) return;

    const second = await acquirePipelineRunLock(dataDir);
    assert.equal(second.acquired, false);
    if (!second.acquired) assert.equal(second.holder?.pid, process.pid);

    await first.lock.release();
    const third = await acquirePipelineRunLock(dataDir);
    assert.equal(third.acquired, true);
    if (third.acquired) await third.lock.release();
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("pipeline run lock recovers an invalid stale lock", async () => {
  const dataDir = await tempDir("ai-news-stale-lock-");
  try {
    await fs.writeFile(path.join(dataDir, "pipeline.lock"), '{"pid":-1,"startedAt":"bad","token":"stale"}\n', "utf8");
    const result = await acquirePipelineRunLock(dataDir);
    assert.equal(result.acquired, true);
    if (result.acquired) await result.lock.release();
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("run status preserves the last success and exposes only safe failure metadata", async () => {
  const dataDir = await tempDir("ai-news-status-");
  const outputDir = path.join(dataDir, "public", "daily");
  const config = parseConfig({ DATA_DIR: dataDir, OUTPUT_DIR: outputDir });
  try {
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(path.join(outputDir, "latest.epub"), "epub-bytes");
    await fs.writeFile(path.join(outputDir, "latest.json"), JSON.stringify({ edition: "2026-08-29" }));

    await recordRunStarted(dataDir, new Date("2026-08-29T04:00:00Z"));
    await recordRunSucceeded(dataDir, "2026-08-29", new Date("2026-08-29T04:05:00Z"));
    let health = await buildDeliveryHealth(config);
    assert.equal(health.degraded, false);
    assert.equal(health.latestEditionDate, "2026-08-29");
    assert.equal(health.lastSuccessfulRunAt, "2026-08-29T04:05:00.000Z");
    assert.equal(health.lastAttemptStatus, "success");

    await recordRunStarted(dataDir, new Date("2026-08-30T04:00:00Z"));
    await recordRunFailed(
      dataDir,
      new LlmError("cloud failed with super-secret-api-key", { context: { apiKey: "super-secret-api-key" } }),
      new Date("2026-08-30T04:01:00Z")
    );

    const status = await readRunStatus(dataDir);
    assert.equal(status?.lastSuccessfulRunAt, "2026-08-29T04:05:00.000Z");
    assert.equal(status?.lastAttemptStatus, "failed");
    assert.equal(status?.lastFailureCode, "LLM_ERROR");
    const raw = await fs.readFile(runStatusPath(dataDir), "utf8");
    assert.doesNotMatch(raw, /super-secret-api-key/);

    health = await buildDeliveryHealth(config);
    assert.equal(health.ok, true);
    assert.equal(health.degraded, true);
    assert.equal(health.lastFailureCode, "LLM_ERROR");
    assert.equal(health.latestEpubPresent, true);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("retention deletes only old dated EPUBs/builds and preserves latest files plus SQLite", async () => {
  const dataDir = await tempDir("ai-news-retention-");
  const outputDir = path.join(dataDir, "public", "daily");
  const buildsDir = path.join(dataDir, "builds");
  const config = parseConfig({
    DATA_DIR: dataDir,
    OUTPUT_DIR: outputDir,
    EDITION_RETENTION_DAYS: "3",
    BUILD_RETENTION_DAYS: "2"
  });

  try {
    await fs.mkdir(outputDir, { recursive: true });
    await fs.mkdir(buildsDir, { recursive: true });
    for (const date of ["2026-08-26", "2026-08-27", "2026-08-28", "2026-08-29"]) {
      await fs.writeFile(path.join(outputDir, `${date}.epub`), date);
      await fs.mkdir(path.join(buildsDir, date), { recursive: true });
      await fs.writeFile(path.join(buildsDir, date, "marker"), date);
    }
    await fs.writeFile(path.join(outputDir, "latest.epub"), "latest");
    await fs.writeFile(path.join(outputDir, "latest.json"), "{}\n");
    await fs.writeFile(path.join(dataDir, "news.sqlite"), "database");
    await fs.mkdir(path.join(buildsDir, "scratch"), { recursive: true });

    const result = await pruneRetention(config, new Date("2026-08-29T12:00:00Z"));
    assert.deepEqual(result, { deletedEditions: 1, deletedBuildDirectories: 2 });
    await assert.rejects(fs.access(path.join(outputDir, "2026-08-26.epub")));
    await fs.access(path.join(outputDir, "2026-08-27.epub"));
    await fs.access(path.join(outputDir, "latest.epub"));
    await fs.access(path.join(dataDir, "news.sqlite"));
    await assert.rejects(fs.access(path.join(buildsDir, "2026-08-27")));
    await fs.access(path.join(buildsDir, "2026-08-28"));
    await fs.access(path.join(buildsDir, "scratch"));
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("systemd examples use absolute runtime paths, a morning timer, and no embedded API keys", async () => {
  const directory = path.join(process.cwd(), "ops", "systemd");
  const serve = await fs.readFile(path.join(directory, "ai-news-assistant-serve.service"), "utf8");
  const run = await fs.readFile(path.join(directory, "ai-news-assistant-run.service"), "utf8");
  const timer = await fs.readFile(path.join(directory, "ai-news-assistant-run.timer"), "utf8");
  const combined = `${serve}\n${run}\n${timer}`;

  assert.match(serve, /ExecStart=\/usr\/bin\/node \/opt\/ai-news-assistant\/dist\/src\/index\.js serve/);
  assert.match(run, /Type=oneshot/);
  assert.match(run, /ExecStart=\/usr\/bin\/node \/opt\/ai-news-assistant\/dist\/src\/index\.js run/);
  assert.match(combined, /EnvironmentFile=\/etc\/ai-news-assistant\.env/);
  assert.match(timer, /OnCalendar=\*-\*-\* 06:00:00/);
  assert.match(timer, /RandomizedDelaySec=30min/);
  assert.match(timer, /Persistent=true/);
  assert.doesNotMatch(combined, /LLM_API_KEY|Bearer\s|sk-[A-Za-z0-9]/);
});
