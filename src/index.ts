import { assertPipelineConfig, loadConfig, loadLocalEnv } from "./config.js";
import { startDeliveryServer } from "./delivery/server.js";
import { runDoctor } from "./doctor.js";
import { OpenAiCompatibleProvider } from "./llm/openai-compatible.js";
import { configureLogging, logger } from "./logging.js";
import { pruneRetention } from "./operations/retention.js";
import { acquirePipelineRunLock } from "./operations/run-lock.js";
import { recordRunFailed, recordRunStarted, recordRunSucceeded } from "./operations/status.js";
import { runPipeline } from "./pipeline.js";
import { MeduzaSource } from "./sources/meduza.js";

async function main(): Promise<void> {
  loadLocalEnv();
  const config = loadConfig();
  configureLogging(config.logLevel);
  const command = process.argv[2] ?? "help";
  const log = logger.child({ component: "cli", command });

  if (command === "serve") {
    const delivery = await startDeliveryServer(config);
    let shuttingDown = false;
    const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      log.info("delivery server shutdown requested", { signal });
      try {
        await delivery.close();
        log.info("delivery server stopped", { signal });
      } catch (error) {
        log.error("delivery server shutdown failed", { signal, error });
        process.exitCode = 1;
      }
    };
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
    process.once("SIGINT", () => void shutdown("SIGINT"));
    return;
  }

  if (command === "run") {
    assertPipelineConfig(config);
    const lockResult = await acquirePipelineRunLock(config.dataDir);
    if (!lockResult.acquired) {
      log.warn("pipeline run skipped because another run is active", {
        holderPid: lockResult.holder?.pid,
        holderStartedAt: lockResult.holder?.startedAt
      });
      return;
    }

    const { lock } = lockResult;
    try {
      await recordRunStarted(config.dataDir);
      const source = new MeduzaSource(config);
      const llm = new OpenAiCompatibleProvider(config);
      const result = await runPipeline(config, source, llm);

      try {
        const retention = await pruneRetention(config);
        log.info("retention cleanup completed", { ...retention });
      } catch (error) {
        log.warn("retention cleanup failed", { error });
      }

      await recordRunSucceeded(config.dataDir, result.editionDate);
      log.info("pipeline generated edition", {
        epubPath: result.epubPath,
        selectedCount: result.selectedCount,
        editionDate: result.editionDate
      });
      return;
    } catch (error) {
      try {
        await recordRunFailed(config.dataDir, error);
      } catch (statusError) {
        log.error("failed to record pipeline failure status", { error: statusError });
      }
      throw error;
    } finally {
      await lock.release().catch((error) => log.error("failed to release pipeline run lock", { error }));
    }
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
    "  run     Fetch, analyze, and build today's EPUB (non-overlapping)\n" +
    "  serve   Serve /healthz, /daily/latest.json, and /daily/latest.epub\n" +
    "  doctor  Validate directories, LLM settings, and Pandoc\n"
  );
}

main().catch((error) => {
  logger.child({ component: "cli" }).error("command failed", { error });
  process.exitCode = 1;
});
