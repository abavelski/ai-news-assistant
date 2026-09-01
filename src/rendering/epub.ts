import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { RenderingError } from "../errors.js";
import type { EditionArticle, EditorialPlan } from "../types.js";
import { sha256 } from "../utils/hash.js";
import type { EditionRenderer, RenderEditionRequest, RenderedEdition } from "./renderer.js";

const execFileAsync = promisify(execFile);
const WORDS_PER_MINUTE = 220;
const TOP_STORY_COUNT = 3;

export const EPUB_RENDERER_VERSION = "pandoc-epub-v1";
export const EPUB_IMAGE_POLICY = "none";

export interface CommandResult {
  stdout?: string;
  stderr?: string;
}

export interface CommandOptions {
  env?: NodeJS.ProcessEnv;
}

export type CommandRunner = (file: string, args: string[], options?: CommandOptions) => Promise<CommandResult>;

export interface PandocEpubRendererDependencies {
  runCommand?: CommandRunner;
  assetsDir?: string;
  now?: () => Date;
}

function isMissingExecutable(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function escapeInlineMarkdown(value: string): string {
  return sanitizeText(value)
    .replace(/\\/g, "\\\\")
    .replace(/([`*_[\]])/g, "\\$1")
    .replace(/\n+/g, " ")
    .trim();
}

export function sanitizeText(value: string): string {
  return value
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .trim();
}

function sanitizeBlock(value: string): string {
  return sanitizeText(value)
    .split("\n")
    .map((line) => line.replace(/^(\s*)(#{1,6}\s|>\s|[-+*]\s|\d+[.)]\s)/, "$1\\$2"))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function safeUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function estimateReadingMinutes(text: string, language = "und"): number {
  const cleaned = sanitizeText(text);
  if (!cleaned) return 1;
  const segmenter = new Intl.Segmenter(language || "und", { granularity: "word" });
  let words = 0;
  for (const segment of segmenter.segment(cleaned)) if (segment.isWordLike) words += 1;
  return Math.max(1, Math.ceil(words / WORDS_PER_MINUTE));
}

function primaryTopic(item: EditionArticle): string | undefined {
  return item.analysis.topics.find((topic) => topic.trim().length > 0)?.trim();
}

function contextString(item: EditionArticle, key: string): string | undefined {
  const value = item.article.sourceContext[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function contextNumber(item: EditionArticle, key: string): number | undefined {
  const value = item.article.sourceContext[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function discussionMarkdown(item: EditionArticle): string[] {
  const { article, analysis } = item;
  const subreddit = contextString(item, "subreddit");
  const author = contextString(item, "postAuthor");
  const score = contextNumber(item, "score");
  const comments = contextNumber(item, "commentCount");
  const sampled = contextNumber(item, "sampledCommentCount");
  const source = subreddit ? `r/${subreddit}` : article.sourceId;
  const metadata = [
    `Source: ${source}`,
    author ? `Posted by u/${author}` : undefined,
    `Published: ${article.publishedAt}`,
    score !== undefined ? `Score: ${score}` : undefined,
    comments !== undefined ? `Comments: ${comments}` : undefined,
    sampled !== undefined ? `Sampled for summary: ${sampled}` : undefined
  ].filter((value): value is string => Boolean(value));

  const lines = [
    `## ${escapeInlineMarkdown(article.title)}`,
    "",
    `*${metadata.map(escapeInlineMarkdown).join(" · ")}*`,
    "",
    "### Why this matters",
    "",
    sanitizeBlock(analysis.reason),
    "",
    "### Discussion summary",
    "",
    sanitizeBlock(analysis.summary),
    ""
  ];

  if (analysis.keyPoints.length > 0) {
    lines.push(
      "### Discussion takeaways",
      "",
      ...analysis.keyPoints.map((point) => `- ${sanitizeBlock(point).replace(/\n+/g, " ")}`),
      ""
    );
  }

  const redditUrl = safeUrl(contextString(item, "permalink") ?? article.url);
  lines.push(redditUrl ? `[Original Reddit discussion](<${redditUrl}>)` : `Original: ${escapeInlineMarkdown(article.url)}`, "");
  const outbound = safeUrl(contextString(item, "outboundUrl") ?? "");
  if (outbound && outbound !== redditUrl) lines.push(`[Linked page](<${outbound}>)`, "");
  return lines;
}

function articleMarkdown(item: EditionArticle, includeFullArticles: boolean, language: string): string[] {
  if (item.article.contentKind === "discussion") return discussionMarkdown(item);

  const { article, analysis } = item;
  const lines = [
    `## ${escapeInlineMarkdown(article.title)}`,
    "",
    `*Source: ${escapeInlineMarkdown(article.sourceId)} · Published: ${escapeInlineMarkdown(article.publishedAt)} · Reading time: ~${estimateReadingMinutes(article.text, language)} min*`,
    "",
    "### Why this matters",
    "",
    sanitizeBlock(analysis.reason),
    "",
    "### Summary",
    "",
    sanitizeBlock(analysis.summary),
    ""
  ];

  if (analysis.keyPoints.length > 0) {
    lines.push("### Key facts", "", ...analysis.keyPoints.map((fact) => `- ${sanitizeBlock(fact).replace(/\n+/g, " ")}`), "");
  }
  if (includeFullArticles) lines.push("### Full article", "", sanitizeBlock(article.text), "");
  const originalUrl = safeUrl(article.url);
  lines.push(originalUrl ? `[Original article](<${originalUrl}>)` : `Original: ${escapeInlineMarkdown(article.url)}`, "");
  return lines;
}

export function buildEditionMarkdown(request: RenderEditionRequest): string {
  const { config, editionDate, plan, selected } = request;
  const title = `Morning Brief — ${editionDate}`;
  const identifier = `urn:ai-news-assistant:edition:${editionDate}`;
  const lines: string[] = [
    "---",
    `title: \"${title}\"`,
    `date: ${editionDate}`,
    `lang: ${config.editionLanguage}`,
    `identifier: \"${identifier}\"`,
    "author: \"AI News Assistant\"",
    "publisher: \"AI News Assistant\"",
    "---",
    "",
    "# Morning Brief",
    "",
    sanitizeBlock(plan.overview),
    ""
  ];

  const topStories = selected.slice(0, Math.min(TOP_STORY_COUNT, selected.length));
  if (topStories.length > 0) {
    lines.push("# Top Stories", "");
    for (const item of topStories) lines.push(...articleMarkdown(item, config.includeFullArticles, config.editionLanguage));
  }

  const remaining = selected.slice(topStories.length);
  const byTopic = new Map<string, EditionArticle[]>();
  for (const item of remaining) {
    const topic = primaryTopic(item);
    if (!topic) continue;
    const existing = byTopic.get(topic) ?? [];
    existing.push(item);
    byTopic.set(topic, existing);
  }

  const groupedIds = new Set<number>();
  for (const [topic, items] of byTopic) {
    if (items.length < 2) continue;
    lines.push(`# ${escapeInlineMarkdown(topic)}`, "");
    for (const item of items) {
      groupedIds.add(item.article.id);
      lines.push(...articleMarkdown(item, config.includeFullArticles, config.editionLanguage));
    }
  }

  const other = remaining.filter((item) => !groupedIds.has(item.article.id));
  if (other.length > 0) {
    lines.push("# Other Headlines", "");
    for (const item of other) lines.push(...articleMarkdown(item, config.includeFullArticles, config.editionLanguage));
  }

  return lines.join("\n").replace(/\n{4,}/g, "\n\n\n").trimEnd() + "\n";
}

async function ensureNonEmptyFile(filePath: string, editionDate: string): Promise<Buffer> {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch (cause) {
    throw new RenderingError("Pandoc did not produce an EPUB output file.", { cause, context: { editionDate, outputPath: filePath } });
  }
  if (!stat.isFile() || stat.size <= 0) {
    throw new RenderingError("Pandoc produced an empty EPUB output file.", {
      context: { editionDate, outputPath: filePath, size: stat.size }
    });
  }
  return fs.readFile(filePath);
}

async function writeAtomic(targetPath: string, data: string | Uint8Array, token: string): Promise<void> {
  const tempPath = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${token}.tmp`);
  try {
    await fs.writeFile(tempPath, data);
    await fs.rename(tempPath, targetPath);
  } catch (cause) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw cause;
  }
}

export class PandocEpubRenderer implements EditionRenderer {
  private readonly runCommand: CommandRunner;
  private readonly assetsDir: string;
  private readonly now: () => Date;

  constructor(dependencies: PandocEpubRendererDependencies = {}) {
    this.runCommand = dependencies.runCommand ?? (async (file, args, options) => execFileAsync(file, args, { env: options?.env }));
    this.assetsDir = dependencies.assetsDir ?? path.resolve(process.cwd(), "src", "rendering", "assets");
    this.now = dependencies.now ?? (() => new Date());
  }

  async render(request: RenderEditionRequest): Promise<RenderedEdition> {
    const { config, editionDate } = request;
    const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const buildDir = path.join(config.dataDir, "builds", editionDate, token);
    const stagedEpubPath = path.join(buildDir, "edition.epub");

    try {
      await fs.mkdir(config.outputDir, { recursive: true });
      await fs.mkdir(buildDir, { recursive: true });
      const cssPath = path.join(this.assetsDir, "epub.css");
      const metadataPath = path.join(this.assetsDir, "epub-metadata.yaml");
      await Promise.all([fs.access(cssPath), fs.access(metadataPath)]);
      const markdownPath = path.join(buildDir, "edition.md");
      await fs.writeFile(markdownPath, buildEditionMarkdown(request), "utf8");

      const title = `Morning Brief — ${editionDate}`;
      const identifier = `urn:ai-news-assistant:edition:${editionDate}`;
      const sourceDateEpoch = Date.parse(`${editionDate}T00:00:00Z`) / 1000;
      await this.runCommand("pandoc", [
        markdownPath,
        "--from=gfm",
        "--to=epub3",
        "--toc",
        "--toc-depth=2",
        `--css=${cssPath}`,
        `--metadata-file=${metadataPath}`,
        `--metadata=date:${editionDate}`,
        `--metadata=lang:${config.editionLanguage}`,
        `--metadata=identifier:${identifier}`,
        `--output=${stagedEpubPath}`
      ], {
        env: { ...process.env, ...(Number.isFinite(sourceDateEpoch) ? { SOURCE_DATE_EPOCH: String(Math.floor(sourceDateEpoch)) } : {}) }
      });

      const epubBytes = await ensureNonEmptyFile(stagedEpubPath, editionDate);
      const digest = sha256(epubBytes);
      const datedPath = path.join(config.outputDir, `${editionDate}.epub`);
      const latestPath = path.join(config.outputDir, "latest.epub");
      const manifestPath = path.join(config.outputDir, "latest.json");
      const generatedAt = this.now().toISOString();
      const manifest = JSON.stringify({
        edition: editionDate,
        generatedAt,
        sha256: digest,
        url: "/daily/latest.epub",
        title,
        language: config.editionLanguage,
        identifier,
        renderer: EPUB_RENDERER_VERSION,
        imagePolicy: EPUB_IMAGE_POLICY,
        selectedCount: request.selected.length,
        includeFullArticles: config.includeFullArticles
      }, null, 2) + "\n";

      await writeAtomic(datedPath, epubBytes, `${token}-dated`);
      await writeAtomic(latestPath, epubBytes, `${token}-latest`);
      await writeAtomic(manifestPath, manifest, `${token}-manifest`);
      return { epubPath: latestPath, manifestPath };
    } catch (cause) {
      if (cause instanceof RenderingError) throw cause;
      if (isMissingExecutable(cause)) {
        throw new RenderingError(
          "Pandoc is required to render EPUB files but was not found on PATH. Install Pandoc or fix the service PATH.",
          { cause, context: { editionDate } }
        );
      }
      throw new RenderingError(`Failed to render EPUB for edition ${editionDate}.`, {
        cause,
        context: { editionDate, outputDir: config.outputDir }
      });
    } finally {
      await fs.rm(buildDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export async function renderEpub(
  config: RenderEditionRequest["config"],
  editionDate: string,
  plan: EditorialPlan,
  selected: EditionArticle[]
): Promise<RenderedEdition> {
  return new PandocEpubRenderer().render({ config, editionDate, plan, selected });
}
