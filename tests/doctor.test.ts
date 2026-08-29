import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseConfig } from "../src/config.js";
import {
  checkLlmConfiguration,
  checkPandocAvailability,
  checkWritableDirectory,
  runDoctor
} from "../src/doctor.js";

test("checkWritableDirectory succeeds for a writable directory", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ai-news-doctor-"));
  try {
    const check = await checkWritableDirectory(directory, "data-directory");
    assert.equal(check.ok, true);
    assert.match(check.detail, /is writable/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("checkWritableDirectory reports an actionable failure", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ai-news-doctor-"));
  const blocker = path.join(directory, "not-a-directory");
  await fs.writeFile(blocker, "file", "utf8");
  try {
    const check = await checkWritableDirectory(path.join(blocker, "child"), "output-directory");
    assert.equal(check.ok, false);
    assert.match(check.detail, /Cannot write to/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("checkLlmConfiguration distinguishes missing and configured models", () => {
  const missing = checkLlmConfiguration(parseConfig({ LLM_MODEL: "" }));
  assert.equal(missing.ok, false);
  assert.match(missing.detail, /LLM_MODEL is required/);

  const configured = checkLlmConfiguration(parseConfig({ LLM_MODEL: "model-a" }));
  assert.equal(configured.ok, true);
  assert.match(configured.detail, /model-a/);
});

test("checkPandocAvailability reports version and missing executable", async () => {
  const available = await checkPandocAvailability(async (executable, args) => {
    assert.equal(executable, "pandoc");
    assert.deepEqual(args, ["--version"]);
    return { stdout: "pandoc 3.1.11\n", stderr: "" };
  });
  assert.equal(available.ok, true);
  assert.equal(available.detail, "pandoc 3.1.11");

  const missing = await checkPandocAvailability(async () => {
    throw Object.assign(new Error("spawn pandoc ENOENT"), { code: "ENOENT" });
  });
  assert.equal(missing.ok, false);
  assert.match(missing.detail, /not available on PATH/);
});

test("runDoctor aggregates directory, LLM, and Pandoc checks", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ai-news-doctor-"));
  try {
    const config = parseConfig({
      DATA_DIR: path.join(directory, "data"),
      OUTPUT_DIR: path.join(directory, "output"),
      LLM_MODEL: "model-a"
    });
    const report = await runDoctor(config, async () => ({ stdout: "pandoc 3.1.11\n", stderr: "" }));
    assert.equal(report.ok, true);
    assert.deepEqual(report.checks.map((check) => check.name), [
      "data-directory",
      "output-directory",
      "llm-configuration",
      "pandoc"
    ]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
