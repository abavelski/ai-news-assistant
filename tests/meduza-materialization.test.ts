import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { parseConfig } from "../src/config.js";
import { MeduzaSource } from "../src/sources/meduza.js";
import type { DiscoveredItem } from "../src/types.js";

test("Meduza adapter owns web materialization and preserves normalized content metadata", async () => {
  const html = await fs.readFile(path.join(process.cwd(), "tests", "fixtures", "meduza", "article.html"), "utf8");
  const config = parseConfig({ MIN_ARTICLE_CHARS: "100" });
  const source = new MeduzaSource(config, {
    fetchFn: async () => new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }),
    sleep: async () => undefined
  });
  const discovered: DiscoveredItem = {
    sourceId: "meduza",
    externalId: "https://meduza.io/feature/2026/08/29/original-slug",
    url: "https://meduza.io/feature/2026/08/29/original-slug",
    title: "RSS fallback title",
    publishedAt: "2026-08-29T03:00:00.000Z",
    contentKind: "article",
    context: { fixture: true }
  };

  const article = await source.materialize(discovered);
  assert.equal(article.sourceId, "meduza");
  assert.equal(article.externalId, discovered.externalId);
  assert.equal(article.contentKind, "article");
  assert.deepEqual(article.sourceContext, { fixture: true });
  assert.match(article.url, /^https:\/\/meduza\.io\//);
  assert.ok(article.text.length >= 100);
});
