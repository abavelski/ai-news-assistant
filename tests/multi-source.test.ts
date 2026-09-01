import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseConfig } from "../src/config.js";
import { runPipeline } from "../src/pipeline.js";
import type { LlmCompletion, LlmMessage, LlmProvider } from "../src/llm/provider.js";
import type { EditionRenderer, RenderEditionRequest, RenderedEdition } from "../src/rendering/renderer.js";
import type { SourceAdapter } from "../src/sources/source.js";
import { SourceConfigRepository } from "../src/storage/source-config.js";
import { NewsDatabase } from "../src/storage/sqlite.js";
import type { Article, DiscoveredItem } from "../src/types.js";
import { sha256 } from "../src/utils/hash.js";

class FakeProvider implements LlmProvider {
  async complete(messages: LlmMessage[]): Promise<LlmCompletion> {
    const prompt = messages.at(-1)?.content ?? "";
    if (prompt.includes("selectedArticleIds")) throw new Error("force deterministic editorial fallback");
    return {
      model: "fake",
      latencyMs: 1,
      content: JSON.stringify({
        summary: "Useful summary",
        topics: ["shared-topic"],
        importance: 80,
        recommended: true,
        reason: "Worth reading",
        keyPoints: ["Point"]
      })
    };
  }
}

class CapturingRenderer implements EditionRenderer {
  request?: RenderEditionRequest;
  async render(request: RenderEditionRequest): Promise<RenderedEdition> {
    this.request = request;
    return { epubPath: "/tmp/latest.epub", manifestPath: "/tmp/latest.json" };
  }
}

function item(sourceId: string, externalId: string, publishedAt: string): DiscoveredItem {
  return {
    sourceId,
    externalId,
    url: `https://example.test/${sourceId}/${externalId}`,
    title: `${sourceId} ${externalId}`,
    publishedAt,
    contentKind: "article",
    context: { fixture: true }
  };
}

function materialized(discovered: DiscoveredItem): Article {
  const text = `Materialized content for ${discovered.sourceId} ${discovered.externalId}. `.repeat(12);
  return {
    sourceId: discovered.sourceId,
    externalId: discovered.externalId,
    url: discovered.url,
    title: discovered.title,
    publishedAt: discovered.publishedAt,
    language: "en",
    contentKind: discovered.contentKind,
    sourceContext: discovered.context,
    text,
    contentHtml: `<p>${text}</p>`,
    contentHash: sha256(text),
    fetchedAt: "2026-09-01T06:10:00Z"
  };
}

function source(
  id: string,
  items: DiscoveredItem[],
  options: { discoveryError?: Error; failExternalIds?: Set<string> } = {}
): SourceAdapter {
  return {
    id,
    type: "fixture",
    async discover() {
      if (options.discoveryError) throw options.discoveryError;
      return items;
    },
    async materialize(discovered) {
      if (options.failExternalIds?.has(discovered.externalId)) throw new Error(`failed ${discovered.externalId}`);
      return materialized(discovered);
    }
  };
}

async function withTempConfig(run: (dataDir: string, config: ReturnType<typeof parseConfig>) => Promise<void>): Promise<void> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-news-multi-source-"));
  try {
    const config = parseConfig({
      DATA_DIR: dataDir,
      OUTPUT_DIR: path.join(dataDir, "public", "daily"),
      LLM_MODEL: "fake-model",
      EDITION_LANGUAGE: "en",
      MAX_ARTICLES: "20",
      EDITION_MAX_ARTICLES: "2",
      EDITORIAL_MAX_PER_TOPIC: "2",
      EDITORIAL_MAX_PER_SOURCE: "1",
      ARTICLE_FETCH_DELAY_MS: "0"
    });
    await run(dataDir, config);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

test("two enabled adapters produce one combined edition while another source discovery failure is isolated", async () => {
  await withTempConfig(async (dataDir, config) => {
    const renderer = new CapturingRenderer();
    const sources = [
      source("alpha", [item("alpha", "one", "2026-09-01T05:00:00Z")]),
      source("broken", [], { discoveryError: new Error("GET https://example.test/feed?token=super-secret failed") }),
      source("beta", [item("beta", "one", "2026-09-01T05:30:00Z")])
    ];

    const result = await runPipeline(config, sources, new FakeProvider(), renderer);
    assert.equal(result.selectedCount, 2);
    assert.deepEqual(new Set(renderer.request?.selected.map((entry) => entry.article.sourceId)), new Set(["alpha", "beta"]));

    const statuses = new SourceConfigRepository(dataDir);
    try {
      assert.equal(statuses.getRunStatus("alpha")?.processedCount, 1);
      assert.equal(statuses.getRunStatus("beta")?.processedCount, 1);
      const broken = statuses.getRunStatus("broken");
      assert.equal(broken?.errorCode, "SOURCE_DISCOVERY_ERROR");
      assert.doesNotMatch(broken?.errorMessage ?? "", /super-secret/);
    } finally {
      statuses.close();
    }

    const db = new NewsDatabase(dataDir);
    try {
      assert.ok(db.getSourceCheckpoint("alpha"));
      assert.ok(db.getSourceCheckpoint("beta"));
      assert.equal(db.getSourceCheckpoint("broken"), undefined);
    } finally {
      db.close();
    }
  });
});

test("a source-specific partial failure stops only that source checkpoint at its failed item", async () => {
  await withTempConfig(async (dataDir, config) => {
    const alphaItems = [
      item("alpha", "older", "2026-09-01T04:00:00Z"),
      item("alpha", "failed", "2026-09-01T05:00:00Z")
    ];
    const betaItems = [item("beta", "ok", "2026-09-01T05:30:00Z")];
    await runPipeline(
      config,
      [source("alpha", alphaItems, { failExternalIds: new Set(["failed"]) }), source("beta", betaItems)],
      new FakeProvider(),
      new CapturingRenderer()
    );

    const db = new NewsDatabase(dataDir);
    try {
      assert.equal(db.getSourceCheckpoint("alpha"), "2026-09-01T05:00:00.000Z");
      assert.notEqual(db.getSourceCheckpoint("beta"), db.getSourceCheckpoint("alpha"));
    } finally {
      db.close();
    }
    const statuses = new SourceConfigRepository(dataDir);
    try {
      const alpha = statuses.getRunStatus("alpha");
      assert.equal(alpha?.discoveredCount, 2);
      assert.equal(alpha?.processedCount, 1);
      assert.equal(alpha?.failedCount, 1);
    } finally {
      statuses.close();
    }
  });
});

test("pipeline fails clearly when no source produces usable content", async () => {
  await withTempConfig(async (_dataDir, config) => {
    await assert.rejects(
      runPipeline(
        config,
        [
          source("broken", [], { discoveryError: new Error("offline") }),
          source("empty", [])
        ],
        new FakeProvider(),
        new CapturingRenderer()
      ),
      /No enabled source produced successfully processed content/
    );
  });
});
