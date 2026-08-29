import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { parseConfig } from "../src/config.js";
import { startDeliveryServer } from "../src/delivery/server.js";
import { recordRunSucceeded } from "../src/operations/status.js";

test("delivery server exposes safe health, serves latest files, and shuts down gracefully", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-news-delivery-"));
  const outputDir = path.join(dataDir, "public", "daily");
  const config = {
    ...parseConfig({ DATA_DIR: dataDir, OUTPUT_DIR: outputDir }),
    host: "127.0.0.1",
    port: 0
  };

  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(path.join(outputDir, "latest.epub"), Buffer.from("fixture-epub"));
  await fs.writeFile(path.join(outputDir, "latest.json"), `${JSON.stringify({ edition: "2026-08-29" })}\n`);
  await recordRunSucceeded(dataDir, "2026-08-29", new Date("2026-08-29T04:05:00Z"));

  const delivery = await startDeliveryServer(config);
  try {
    const address = delivery.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const healthResponse = await fetch(`${baseUrl}/healthz?probe=1`);
    assert.equal(healthResponse.status, 200);
    const health = await healthResponse.json() as Record<string, unknown>;
    assert.equal(health.ok, true);
    assert.equal(health.degraded, false);
    assert.equal(health.latestEditionDate, "2026-08-29");
    assert.equal(health.lastSuccessfulRunAt, "2026-08-29T04:05:00.000Z");

    const epub = await fetch(`${baseUrl}/daily/latest.epub`);
    assert.equal(epub.status, 200);
    assert.equal(epub.headers.get("content-type"), "application/epub+zip");
    assert.equal(await epub.text(), "fixture-epub");

    const head = await fetch(`${baseUrl}/daily/latest.json`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.ok(Number(head.headers.get("content-length")) > 0);
    assert.equal(await head.text(), "");

    const method = await fetch(`${baseUrl}/daily/latest.epub`, { method: "POST" });
    assert.equal(method.status, 405);
  } finally {
    await delivery.close();
    assert.equal(delivery.server.listening, false);
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
