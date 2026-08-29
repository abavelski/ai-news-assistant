import assert from "node:assert/strict";
import test from "node:test";
import { parseConfig } from "../src/config.js";
import { MeduzaSource } from "../src/sources/meduza.js";
import { normalizeMeduzaUrl } from "../src/sources/meduza-url.js";

test("normalizeMeduzaUrl canonicalizes host, scheme, slash, fragment, and tracking parameters", () => {
  assert.equal(
    normalizeMeduzaUrl("http://www.meduza.io/feature/2026/08/29/story/?utm_source=rss&utm_medium=feed#part"),
    "https://meduza.io/feature/2026/08/29/story"
  );
});

test("Meduza discovery is RSS-driven and deduplicates normalized article URLs", async () => {
  const rss = `<?xml version="1.0" encoding="UTF-8"?>
    <rss version="2.0"><channel><title>Fixture</title>
      <item><title>Story A</title><link>https://meduza.io/feature/2026/08/29/story?utm_source=rss</link><guid>a</guid><pubDate>Sat, 29 Aug 2026 12:00:00 GMT</pubDate></item>
      <item><title>Story A duplicate</title><link>http://www.meduza.io/feature/2026/08/29/story/#top</link><guid>b</guid><pubDate>Sat, 29 Aug 2026 12:01:00 GMT</pubDate></item>
      <item><title>Old story</title><link>https://meduza.io/news/2026/08/27/old</link><guid>old</guid><pubDate>Thu, 27 Aug 2026 12:00:00 GMT</pubDate></item>
    </channel></rss>`;
  let requestedUrl = "";
  const config = parseConfig({ MAX_ARTICLES: "10", EDITION_MAX_ARTICLES: "10" });
  const source = new MeduzaSource(config, {
    fetchFn: async (input) => {
      requestedUrl = String(input);
      return new Response(rss, { status: 200, headers: { "content-type": "application/rss+xml" } });
    },
    sleep: async () => undefined
  });

  const items = await source.discover(new Date("2026-08-29T00:00:00Z"));
  assert.equal(requestedUrl, config.meduzaRssUrl);
  assert.equal(items.length, 1);
  assert.equal(items[0]?.url, "https://meduza.io/feature/2026/08/29/story");
  assert.equal(items[0]?.title, "Story A");
});
