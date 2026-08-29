import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertPipelineConfig, loadLocalEnv, parseConfig } from "../src/config.js";
import { ConfigurationError } from "../src/errors.js";

test("parseConfig uses safe defaults", () => {
  const config = parseConfig({});
  assert.equal(config.port, 8787);
  assert.equal(config.lookbackHours, 24);
  assert.equal(config.maxArticles, 50);
  assert.equal(config.editionMaxArticles, 10);
  assert.equal(config.includeFullArticles, true);
  assert.equal(config.llmBaseUrl, "http://127.0.0.1:11434");
  assert.equal(config.logLevel, "info");
});

test("parseConfig parses explicit values", () => {
  const config = parseConfig({
    DATA_DIR: "./tmp-data",
    OUTPUT_DIR: "./tmp-output",
    HOST: "127.0.0.1",
    PORT: "9999",
    LOOKBACK_HOURS: "48",
    MAX_ARTICLES: "80",
    EDITION_MAX_ARTICLES: "12",
    EDITION_LANGUAGE: "en",
    INCLUDE_FULL_ARTICLES: "off",
    MEDUZA_RSS_URL: "https://example.com/feed.xml",
    LLM_BASE_URL: "https://llm.example.test/",
    LLM_MODEL: "test-model",
    LLM_API_KEY: "secret",
    LOG_LEVEL: "debug"
  });

  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 9999);
  assert.equal(config.lookbackHours, 48);
  assert.equal(config.maxArticles, 80);
  assert.equal(config.editionMaxArticles, 12);
  assert.equal(config.editionLanguage, "en");
  assert.equal(config.includeFullArticles, false);
  assert.equal(config.llmBaseUrl, "https://llm.example.test");
  assert.equal(config.llmModel, "test-model");
  assert.equal(config.llmApiKey, "secret");
  assert.equal(config.logLevel, "debug");
});

test("parseConfig rejects invalid PORT values with an actionable configuration error", () => {
  assert.throws(
    () => parseConfig({ PORT: "70000" }),
    (error: unknown) => error instanceof ConfigurationError && /PORT must be an integer between 1 and 65535/.test(error.message)
  );
});

test("parseConfig rejects invalid booleans and cross-field article limits", () => {
  assert.throws(() => parseConfig({ INCLUDE_FULL_ARTICLES: "sometimes" }), ConfigurationError);
  assert.throws(
    () => parseConfig({ MAX_ARTICLES: "5", EDITION_MAX_ARTICLES: "6" }),
    /EDITION_MAX_ARTICLES \(6\) must not exceed MAX_ARTICLES \(5\)/
  );
});

test("assertPipelineConfig rejects an empty LLM_MODEL for run", () => {
  const config = parseConfig({ LLM_MODEL: "   " });
  assert.throws(
    () => assertPipelineConfig(config),
    (error: unknown) => error instanceof ConfigurationError && /LLM_MODEL is required for the run command/.test(error.message)
  );
});

test("loadLocalEnv loads missing values without overriding service environment", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ai-news-env-"));
  const envPath = path.join(directory, ".env");
  const variable = `AI_NEWS_TEST_${Date.now()}`;
  const preserved = `${variable}_PRESERVED`;
  const previousVariable = process.env[variable];
  const previousPreserved = process.env[preserved];

  try {
    await fs.writeFile(envPath, `${variable}=from-file\n${preserved}=from-file\n`, "utf8");
    process.env[preserved] = "from-systemd";
    delete process.env[variable];

    assert.equal(loadLocalEnv(envPath), true);
    assert.equal(process.env[variable], "from-file");
    assert.equal(process.env[preserved], "from-systemd");
  } finally {
    if (previousVariable === undefined) delete process.env[variable];
    else process.env[variable] = previousVariable;
    if (previousPreserved === undefined) delete process.env[preserved];
    else process.env[preserved] = previousPreserved;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
