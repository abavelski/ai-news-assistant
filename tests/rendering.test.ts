import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseConfig } from "../src/config.js";
import { RenderingError } from "../src/errors.js";
import {
  buildEditionMarkdown,
  EPUB_IMAGE_POLICY,
  EPUB_RENDERER_VERSION,
  estimateReadingMinutes,
  PandocEpubRenderer,
  sanitizeText,
  type CommandRunner
} from "../src/rendering/epub.js";
import type { EditionRenderer } from "../src/rendering/renderer.js";
import type { EditionArticle, EditorialPlan } from "../src/types.js";
import { sha256 } from "../src/utils/hash.js";

function item(id: number, topic: string, title = `Story ${id}`, text = "word ".repeat(450)): EditionArticle {
  return {
    article: {
      id,
      sourceId: "meduza",
      externalId: `story-${id}`,
      url: `https://meduza.io/feature/story-${id}`,
      title,
      publishedAt: `2026-08-29T${String(10 + id).padStart(2, "0")}:00:00.000Z`,
      language: "ru",
      contentKind: "article",
      sourceContext: {},
      text,
      contentHtml: `<p>${text}</p>`,
      contentHash: `hash-${id}`,
      fetchedAt: "2026-08-29T18:00:00.000Z"
    },
    analysis: {
      articleId: id,
      summary: `Краткое содержание ${id}`,
      topics: topic ? [topic] : [],
      importance: 80 - id,
      recommended: true,
      reason: `Почему это важно ${id}`,
      keyPoints: [`Факт ${id}`],
      analyzedAt: "2026-08-29T18:01:00.000Z",
      modelName: "test-model",
      promptVersion: "article-analysis-v1",
      analysisVersion: "article-analysis-schema-v1",
      latencyMs: 10
    }
  } as unknown as EditionArticle;
}

const plan: EditorialPlan = {
  overview: "Доброе утро. Это краткий обзор главных событий.",
  selectedArticleIds: [1, 2, 3, 4, 5, 6]
};

async function tempConfig(includeFullArticles = true) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-news-render-"));
  const outputDir = path.join(dataDir, "public", "daily");
  const config = parseConfig({
    DATA_DIR: dataDir,
    OUTPUT_DIR: outputDir,
    INCLUDE_FULL_ARTICLES: includeFullArticles ? "true" : "false",
    LLM_MODEL: "test-model"
  });
  return { dataDir, outputDir, config };
}

function outputPath(args: string[]): string {
  const value = args.find((arg) => arg.startsWith("--output="));
  assert.ok(value, "renderer must pass --output to Pandoc");
  return value.slice("--output=".length);
}

test("edition markdown has newspaper hierarchy, topic grouping, reading time, attribution, and sanitized content", async () => {
  const { dataDir, config } = await tempConfig(true);
  try {
    const selected = [
      item(1, "Политика"),
      item(2, "Мир"),
      item(3, "Экономика"),
      item(4, "Наука", "Story <script>alert(1)</script>", "first\n# injected heading\n<script>bad()</script>"),
      item(5, "Наука"),
      item(6, "Культура")
    ];
    const markdown = buildEditionMarkdown({ config, editionDate: "2026-08-29", plan, selected });

    assert.match(markdown, /^---\ntitle: "Morning Brief — 2026-08-29"/);
    assert.match(markdown, /# Morning Brief/);
    assert.match(markdown, /# Top Stories/);
    assert.match(markdown, /# Наука/);
    assert.match(markdown, /# Other Headlines/);
    assert.match(markdown, /Reading time: ~\d+ min/);
    assert.match(markdown, /\[Original article\]\(<https:\/\/meduza\.io\/feature\/story-1>\)/);
    assert.match(markdown, /### Full article/);
    assert.doesNotMatch(markdown, /<script>/);
    assert.match(markdown, /&lt;script&gt;/);
    assert.match(markdown, /\\# injected heading/);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("full article inclusion remains configurable", async () => {
  const enabled = await tempConfig(true);
  const disabled = await tempConfig(false);
  try {
    const selected = [item(1, "Мир")];
    assert.match(buildEditionMarkdown({ config: enabled.config, editionDate: "2026-08-29", plan, selected }), /### Full article/);
    assert.doesNotMatch(buildEditionMarkdown({ config: disabled.config, editionDate: "2026-08-29", plan, selected }), /### Full article/);
  } finally {
    await fs.rm(enabled.dataDir, { recursive: true, force: true });
    await fs.rm(disabled.dataDir, { recursive: true, force: true });
  }
});

test("reading time and sanitization are deterministic", () => {
  assert.equal(estimateReadingMinutes("word ".repeat(1), "en"), 1);
  assert.equal(estimateReadingMinutes("word ".repeat(440), "en"), 2);
  assert.equal(sanitizeText("a\u0000b\r\n<c>"), "ab\n&lt;c&gt;");
});

test("renderer stages output, passes EPUB3 metadata and TOC options, then atomically publishes latest files", async () => {
  const { dataDir, outputDir, config } = await tempConfig(false);
  const calls: Array<{ file: string; args: string[]; sourceDateEpoch?: string }> = [];
  const fakeBytes = Buffer.from("fake deterministic epub bytes");
  const runner: CommandRunner = async (file, args, options) => {
    calls.push({ file, args, sourceDateEpoch: options?.env?.SOURCE_DATE_EPOCH });
    await fs.writeFile(outputPath(args), fakeBytes);
    return { stdout: "", stderr: "" };
  };

  try {
    const renderer: EditionRenderer = new PandocEpubRenderer({
      runCommand: runner,
      now: () => new Date("2026-08-29T18:30:00.000Z")
    });
    const result = await renderer.render({
      config,
      editionDate: "2026-08-29",
      plan,
      selected: [item(1, "Мир")]
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.file, "pandoc");
    assert.equal(calls[0]?.sourceDateEpoch, String(Date.parse("2026-08-29T00:00:00Z") / 1000));
    const args = calls[0]?.args ?? [];
    assert.ok(args.includes("--to=epub3"));
    assert.ok(args.includes("--toc"));
    assert.ok(args.includes("--toc-depth=2"));
    assert.ok(args.some((arg) => arg.endsWith("src/rendering/assets/epub.css") && arg.startsWith("--css=")));
    assert.ok(args.some((arg) => arg === "--metadata=date:2026-08-29"));
    assert.ok(args.some((arg) => arg === "--metadata=lang:ru"));
    assert.ok(args.some((arg) => arg === "--metadata=identifier:urn:ai-news-assistant:edition:2026-08-29"));

    assert.deepEqual(await fs.readFile(path.join(outputDir, "2026-08-29.epub")), fakeBytes);
    assert.deepEqual(await fs.readFile(result.epubPath), fakeBytes);
    const manifest = JSON.parse(await fs.readFile(result.manifestPath, "utf8")) as Record<string, unknown>;
    assert.equal(manifest.sha256, sha256(fakeBytes));
    assert.equal(manifest.generatedAt, "2026-08-29T18:30:00.000Z");
    assert.equal(manifest.identifier, "urn:ai-news-assistant:edition:2026-08-29");
    assert.equal(manifest.renderer, EPUB_RENDERER_VERSION);
    assert.equal(manifest.imagePolicy, EPUB_IMAGE_POLICY);
    assert.equal(manifest.includeFullArticles, false);
    assert.equal(manifest.selectedCount, 1);

    const outputNames = await fs.readdir(outputDir);
    assert.equal(outputNames.some((name) => name.endsWith(".tmp")), false);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("failed Pandoc render preserves the previous latest EPUB", async () => {
  const { dataDir, outputDir, config } = await tempConfig(true);
  const previous = Buffer.from("previous known-good epub");
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(path.join(outputDir, "latest.epub"), previous);

  try {
    const renderer = new PandocEpubRenderer({
      runCommand: async () => { throw new Error("pandoc exploded"); }
    });
    await assert.rejects(
      renderer.render({ config, editionDate: "2026-08-29", plan, selected: [item(1, "Мир")] }),
      (error: unknown) => error instanceof RenderingError && /Failed to render EPUB/.test(error.message)
    );
    assert.deepEqual(await fs.readFile(path.join(outputDir, "latest.epub")), previous);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("missing or empty Pandoc output is rejected before latest EPUB replacement", async () => {
  for (const mode of ["missing", "empty"] as const) {
    const { dataDir, outputDir, config } = await tempConfig(true);
    const previous = Buffer.from("previous known-good epub");
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(path.join(outputDir, "latest.epub"), previous);

    try {
      const renderer = new PandocEpubRenderer({
        runCommand: async (_file, args) => {
          if (mode === "empty") await fs.writeFile(outputPath(args), Buffer.alloc(0));
          return {};
        }
      });
      await assert.rejects(
        renderer.render({ config, editionDate: "2026-08-29", plan, selected: [item(1, "Мир")] }),
        (error: unknown) => error instanceof RenderingError && /did not produce|empty EPUB/.test(error.message)
      );
      assert.deepEqual(await fs.readFile(path.join(outputDir, "latest.epub")), previous);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  }
});

test("discussion content uses discussion-specific headings and never embeds the raw snapshot", async () => {
  const { dataDir, config } = await tempConfig(true);
  try {
    const discussion = item(7, "Community");
    discussion.article.contentKind = "discussion";
    discussion.article.sourceId = "reddit:selfhosted";
    discussion.article.url = "https://www.reddit.com/r/selfhosted/comments/abc123/example/";
    discussion.article.sourceContext = {
      subreddit: "selfhosted",
      score: 42,
      commentCount: 17,
      outboundUrl: "https://example.test/project"
    };
    discussion.article.text = "RAW COMMENT SNAPSHOT SHOULD NOT BE RENDERED";
    const markdown = buildEditionMarkdown({
      config,
      editionDate: "2026-08-29",
      plan: { overview: "Overview", selectedArticleIds: [7] },
      selected: [discussion]
    });
    assert.match(markdown, /r\/selfhosted/);
    assert.match(markdown, /Comments: 17/);
    assert.match(markdown, /Score: 42/);
    assert.match(markdown, /### Discussion summary/);
    assert.match(markdown, /### Discussion takeaways/);
    assert.match(markdown, /\[Original Reddit discussion\]/);
    assert.match(markdown, /\[Linked page\]/);
    assert.doesNotMatch(markdown, /RAW COMMENT SNAPSHOT/);
    assert.doesNotMatch(markdown, /### Key facts/);
    assert.doesNotMatch(markdown, /### Full article/);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});