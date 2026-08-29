import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { ExtractionError, FetchError } from "../src/errors.js";
import { extractArticleFromHtml, fetchAndExtract } from "../src/extraction/readability.js";
import type { DiscoveredItem } from "../src/types.js";

const fixtureDir = path.join(process.cwd(), "tests", "fixtures", "meduza");
const item: DiscoveredItem = {
  sourceId: "meduza",
  externalId: "fixture-story",
  url: "https://meduza.io/feature/2026/08/29/example-story?utm_source=feed",
  title: "RSS fallback title",
  publishedAt: "2026-08-29T03:00:00.000Z"
};

test("Meduza extraction prefers canonical and page metadata and removes source-specific related material", async () => {
  const html = await fs.readFile(path.join(fixtureDir, "article.html"), "utf8");
  const article = extractArticleFromHtml(item, html, { language: "ru", minArticleChars: 200 });

  assert.equal(article.url, "https://meduza.io/feature/2026/08/29/example-story");
  assert.match(article.title, /Fixture Meduza headline|Fixture browser title/);
  assert.equal(article.author, "Meduza Fixture Author");
  assert.equal(article.publishedAt, "2026-08-29T04:15:00.000Z");
  assert.match(article.text, /первый абзац/);
  assert.doesNotMatch(article.text, /рекламный связанный блок/);
  assert.doesNotMatch(article.contentHtml, /related-materials/);
});

test("Meduza extraction rejects malformed or very short non-article pages", async () => {
  const html = await fs.readFile(path.join(fixtureDir, "malformed.html"), "utf8");
  assert.throws(
    () => extractArticleFromHtml(item, html, { minArticleChars: 200 }),
    (error: unknown) => error instanceof ExtractionError && /too short|could not extract/i.test(error.message)
  );
});

test("article HTTP failure is reported as FetchError without network access", async () => {
  await assert.rejects(
    fetchAndExtract(item, {
      language: "ru",
      userAgent: "fixture-agent/1.0",
      timeoutMs: 5_000,
      retries: 0,
      retryBaseDelayMs: 0,
      minArticleChars: 200,
      fetchFn: async () => new Response("nope", { status: 500, statusText: "Server Error" }),
      sleep: async () => undefined
    }),
    (error: unknown) => error instanceof FetchError && /HTTP 500/.test(error.message)
  );
});
