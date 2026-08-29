import { assertPipelineConfig, loadConfig, loadLocalEnv } from "./config.js";
import { startDeliveryServer } from "./delivery/server.js";
import { runDoctor } from "./doctor.js";
import { OpenAiCompatibleProvider } from "./llm/openai-compatible.js";
import { configureLogging, logger } from "./logging.js";
import { runPipeline } from "./pipeline.js";
import { MeduzaSource } from "./sources/meduza.js";

async function main(): Promise<void> {
  loadLocalEnv();
  const config = loadConfig();
  configureLogging(config.logLevel);
  const command = process.argv[2] ?? "help";
  const log = logger.child({ component: "cli", command });

  if (command === "serve") {
    startDeliveryServer(config);
    return;
  }

  if (command === "run") {
    assertPipelineConfig(config);
    const source = new MeduzaSource(config);
    const llm = new OpenAiCompatibleProvider(config);
    const result = await runPipeline(config, source, llm);
    log.info("pipeline generated edition", {
      epubPath: result.epubPath,
      selectedCount: result.selectedCount,
      editionDate: result.editionDate
    });
    return;
  }

  if (command === "doctor") {
    const report = await runDoctor(config);
    for (const check of report.checks) {
      const context = { check: check.name, ok: check.ok, detail: check.detail };
      if (check.ok) log.info("doctor check passed", context);
      else log.error("doctor check failed", context);
    }
    if (!report.ok) process.exitCode = 1;
    return;
  }

  process.stdout.write(
    "ai-news-assistant\n\nCommands:\n" +
    "  run     Fetch, analyze, and build today's EPUB\n" +
    "  serve   Serve /daily/latest.json and /daily/latest.epub\n" +
    "  doctor  Validate directories, LLM settings, and Pandoc\n"
  );
}

main().catch((error) => {
  logger.child({ component: "cli" }).error("command failed", { error });
  process.exitCode = 1;
});
