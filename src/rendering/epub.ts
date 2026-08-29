import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { AppConfig } from "../config.js";
import type { EditionArticle, EditorialPlan } from "../types.js";
import { sha256 } from "../utils/hash.js";

const execFileAsync = promisify(execFile);

function markdownEscapeTitle(value: string): string {
  return value.replace(/\n/g, " ").trim();
}

export async function renderEpub(
  config: AppConfig,
  editionDate: string,
  plan: EditorialPlan,
  selected: EditionArticle[]
): Promise<{ epubPath: string; manifestPath: string }> {
  await fs.mkdir(config.outputDir, { recursive: true });
  const buildDir = path.join(config.dataDir, "builds", editionDate);
  await fs.mkdir(buildDir, { recursive: true });

  const lines: string[] = [
    "---",
    `title: \"Morning Brief — ${editionDate}\"`,
    `lang: ${config.editionLanguage}`,
    "---",
    "",
    "# The morning in brief",
    "",
    plan.overview,
    ""
  ];

  for (const { article, analysis } of selected) {
    lines.push(`# ${markdownEscapeTitle(article.title)}`, "");
    lines.push(`*Source: ${article.sourceId} · Published: ${article.publishedAt}*`, "");
    lines.push("## Why this matters", "", analysis.reason, "");
    lines.push("## Summary", "", analysis.summary, "");
    if (analysis.keyFacts.length) {
      lines.push("## Key facts", "", ...analysis.keyFacts.map((fact) => `- ${fact}`), "");
    }
    if (config.includeFullArticles) {
      lines.push("## Full article", "", article.text, "");
    }
    lines.push(`Original: ${article.url}`, "");
  }

  const markdownPath = path.join(buildDir, "edition.md");
  await fs.writeFile(markdownPath, lines.join("\n"), "utf8");

  const datedPath = path.join(config.outputDir, `${editionDate}.epub`);
  const latestPath = path.join(config.outputDir, "latest.epub");
  await execFileAsync("pandoc", [markdownPath, "--from=gfm", "--to=epub3", "--toc", "--output", datedPath]);
  await fs.copyFile(datedPath, latestPath);

  const digest = sha256(await fs.readFile(latestPath));
  const manifestPath = path.join(config.outputDir, "latest.json");
  await fs.writeFile(manifestPath, JSON.stringify({
    edition: editionDate,
    generatedAt: new Date().toISOString(),
    sha256: digest,
    url: "/daily/latest.epub"
  }, null, 2));

  return { epubPath: latestPath, manifestPath };
}
