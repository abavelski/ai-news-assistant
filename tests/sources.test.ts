import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseConfig } from "../src/config.js";
import { ConfigurationError } from "../src/errors.js";
import { checkSourceConfiguration } from "../src/doctor.js";
import { validateNonSecretSettings } from "../src/sources/config.js";
import { createDefaultSourceRegistry, SourceRegistry } from "../src/sources/registry.js";
import { SourceConfigService } from "../src/sources/service.js";
import type { SourceAdapter } from "../src/sources/source.js";
import { SourceConfigRepository } from "../src/storage/source-config.js";

async function withRepository(run: (dataDir: string, repository: SourceConfigRepository) => Promise<void> | void): Promise<void> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-news-sources-"));
  const repository = new SourceConfigRepository(dataDir);
  try {
    await run(dataDir, repository);
  } finally {
    repository.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

function fixtureRegistry(): SourceRegistry {
  return createDefaultSourceRegistry().register<{ label: string }>({
    type: "fixture",
    displayName: "Fixture",
    settingsVersion: 1,
    settings: [{ name: "label", type: "string", required: true, label: "Label" }],
    secretRequirements: ["FIXTURE_TOKEN"],
    validateSettings(value, version) {
      if (version !== 1) throw new ConfigurationError("fixture settings version must be 1");
      const settings = validateNonSecretSettings(value);
      if (typeof settings.label !== "string" || !settings.label.trim()) {
        throw new ConfigurationError("fixture label is required");
      }
      return { label: settings.label.trim() };
    },
    createAdapter(config): SourceAdapter {
      return {
        id: config.id,
        type: "fixture",
        async discover() { return []; },
        async materialize() { throw new Error("not used"); }
      };
    },
    missingRuntimeSecrets() { return []; }
  });
}

test("fresh source store bootstraps Meduza once and persisted settings become authoritative", async () => {
  await withRepository((_dataDir, repository) => {
    const service = new SourceConfigService(repository, createDefaultSourceRegistry(), () => new Date("2026-09-01T06:00:00Z"));
    const first = service.bootstrapDefaultMeduza("https://meduza.io/rss/all");
    assert.equal(first?.id, "meduza");
    assert.deepEqual(first?.settings, { rssUrl: "https://meduza.io/rss/all" });

    service.bootstrapDefaultMeduza("https://example.test/changed.xml");
    assert.deepEqual(service.get("meduza")?.settings, { rssUrl: "https://meduza.io/rss/all" });
    assert.equal(service.list().length, 1);
  });
});

test("source service validates create/update/enable-disable and keeps id/type immutable", async () => {
  await withRepository((_dataDir, repository) => {
    const service = new SourceConfigService(repository, fixtureRegistry(), () => new Date("2026-09-01T06:00:00Z"));
    service.bootstrapDefaultMeduza("https://meduza.io/rss/all");
    const created = service.create({ id: "fixture:one", type: "fixture", displayName: "One", settings: { label: "first" } });
    assert.equal(created.enabled, true);
    assert.equal(created.type, "fixture");

    const updated = service.update("fixture:one", { displayName: "Updated", settings: { label: "second" } });
    assert.equal(updated.id, "fixture:one");
    assert.equal(updated.type, "fixture");
    assert.deepEqual(updated.settings, { label: "second" });

    assert.equal(service.setEnabled("fixture:one", false).enabled, false);
    assert.equal(service.setEnabled("fixture:one", true).enabled, true);
    assert.equal(service.listWithStatus().length, 2);
  });
});

test("source settings reject credentials and unknown source types", async () => {
  await withRepository((_dataDir, repository) => {
    const service = new SourceConfigService(repository, fixtureRegistry());
    assert.throws(
      () => service.create({ id: "fixture:secret", type: "fixture", settings: { label: "x", apiKey: "do-not-store" } }),
      (error: unknown) => error instanceof ConfigurationError && /credential/.test(error.message)
    );
    assert.throws(
      () => service.create({ id: "unknown:one", type: "unknown", settings: {} }),
      (error: unknown) => error instanceof ConfigurationError && /Unknown source type/.test(error.message)
    );
  });
});

test("source registry exposes GUI-safe type metadata without secret values", () => {
  const types = fixtureRegistry().listTypes();
  const fixture = types.find((entry) => entry.type === "fixture");
  assert.deepEqual(fixture?.settings, [{ name: "label", type: "string", required: true, label: "Label" }]);
  assert.deepEqual(fixture?.secretRequirements, ["FIXTURE_TOKEN"]);
});

test("source run status persists compact counters while preserving last success after failure", async () => {
  await withRepository((_dataDir, repository) => {
    repository.recordAttempt({
      sourceId: "meduza",
      sourceType: "meduza",
      attemptedAt: "2026-09-01T06:00:00Z",
      succeeded: true,
      checkpoint: "2026-09-01T06:00:00Z",
      discoveredCount: 5,
      processedCount: 4,
      failedCount: 1
    });
    repository.recordAttempt({
      sourceId: "meduza",
      sourceType: "meduza",
      attemptedAt: "2026-09-02T06:00:00Z",
      succeeded: false,
      checkpoint: "2026-09-01T06:00:00Z",
      discoveredCount: 0,
      processedCount: 0,
      failedCount: 0,
      errorCode: "FETCH_ERROR",
      errorMessage: "temporary failure"
    });
    const status = repository.getRunStatus("meduza");
    assert.equal(status?.lastAttemptAt, "2026-09-02T06:00:00Z");
    assert.equal(status?.lastSuccessAt, "2026-09-01T06:00:00Z");
    assert.equal(status?.checkpoint, "2026-09-01T06:00:00Z");
    assert.equal(status?.errorCode, "FETCH_ERROR");
  });
});

test("doctor reports invalid persisted source configuration instead of failing deep in a run", async () => {
  await withRepository((dataDir, repository) => {
    repository.insert({
      id: "unknown:one",
      type: "unknown",
      enabled: true,
      displayName: "Unknown",
      settingsVersion: 1,
      settings: {},
      createdAt: "2026-09-01T06:00:00Z",
      updatedAt: "2026-09-01T06:00:00Z"
    });
    const check = checkSourceConfiguration(parseConfig({ DATA_DIR: dataDir, LLM_MODEL: "model" }));
    assert.equal(check.ok, false);
    assert.match(check.detail, /Unknown source type/);
  });
});
