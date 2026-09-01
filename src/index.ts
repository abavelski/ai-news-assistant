import { assertPipelineConfig, loadConfig, loadLocalEnv } from "./config.js";
import { startDeliveryServer } from "./delivery/server.js";
import { ConfigurationError } from "./errors.js";
import { runDoctor } from "./doctor.js";
import { OpenAiCompatibleProvider } from "./llm/openai-compatible.js";
import { configureLogging, logger } from "./logging.js";
import { pruneRetention } from "./operations/retention.js";
import { acquirePipelineRunLock } from "./operations/run-lock.js";
import { recordRunFailed, recordRunStarted, recordRunSucceeded } from "./operations/status.js";
import { runPipeline } from "./pipeline.js";
import { createDefaultSourceRegistry } from "./sources/registry.js";
import { defaultRedditSettings, normalizeSubredditName, redditSourceId } from "./sources/reddit.js";
import { SourceConfigService } from "./sources/service.js";
import { SourceConfigRepository } from "./storage/source-config.js";

function parseSettingsJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (cause) {
    throw new ConfigurationError("Source settings must be provided as valid JSON.", { cause });
  }
}

async function runSourcesCommand(config: ReturnType<typeof loadConfig>, args: string[]): Promise<void> {
  const registry = createDefaultSourceRegistry();
  const repository = new SourceConfigRepository(config.dataDir);
  const service = new SourceConfigService(repository, registry);
  try {
    service.bootstrapDefaultMeduza(config.meduzaRssUrl);
    const subcommand = args[0] ?? "list";

    if (subcommand === "list") {
      process.stdout.write(JSON.stringify({ sources: service.listWithStatus() }, null, 2) + "\n");
      return;
    }

    if (subcommand === "types") {
      process.stdout.write(JSON.stringify({ sourceTypes: registry.listTypes() }, null, 2) + "\n");
      return;
    }

    if (subcommand === "add") {
      const [type, idOrSubreddit, settingsJson, displayName] = args.slice(1);
      if (type === "reddit" && idOrSubreddit && !settingsJson) {
        const subreddit = normalizeSubredditName(idOrSubreddit);
        const created = service.create({
          type: "reddit",
          id: redditSourceId(subreddit),
          settings: defaultRedditSettings(subreddit),
          displayName: `r/${subreddit}`
        });
        process.stdout.write(JSON.stringify(created, null, 2) + "\n");
        return;
      }
      if (!type || !idOrSubreddit || !settingsJson) {
        throw new ConfigurationError(
          "Usage: sources add reddit <subreddit> OR sources add <type> <id> '<settings-json>' [display-name]"
        );
      }
      const created = service.create({
        type,
        id: idOrSubreddit,
        settings: parseSettingsJson(settingsJson),
        displayName
      });
      process.stdout.write(JSON.stringify(created, null, 2) + "\n");
      return;
    }

    if (subcommand === "update") {
      const [id, settingsJson, displayName] = args.slice(1);
      if (!id || !settingsJson) throw new ConfigurationError("Usage: sources update <id> '<settings-json>' [display-name]");
      const updated = service.update(id, {
        settings: parseSettingsJson(settingsJson),
        ...(displayName ? { displayName } : {})
      });
      process.stdout.write(JSON.stringify(updated, null, 2) + "\n");
      return;
    }

    if (subcommand === "enable" || subcommand === "disable") {
      const id = args[1];
      if (!id) throw new ConfigurationError(`Usage: sources ${subcommand} <id>`);
      const updated = service.setEnabled(id, subcommand === "enable");
      process.stdout.write(JSON.stringify(updated, null, 2) + "\n");
      return;
    }

    throw new ConfigurationError(
      `Unknown sources subcommand ${JSON.stringify(subcommand)}. Use list, types, add, update, enable, or disable.`
    );
  } finally {
    repository.close();
  }
}

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
      const registry = createDefaultSourceRegistry();
      const repository = new SourceConfigRepository(config.dataDir);
      let adapters;
      try {
        const service = new SourceConfigService(repository, registry);
        service.bootstrapDefaultMeduza(config.meduzaRssUrl);
        const sourceConfigs = service.assertRunnable().sort((left, right) => left.id.localeCompare(right.id));
        adapters = sourceConfigs.map((sourceConfig) => registry.createAdapter(sourceConfig, config));
      } finally {
        repository.close();
      }

      const llm = new OpenAiCompatibleProvider(config);
      const result = await runPipeline(config, adapters, llm);

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
        editionDate: result.editionDate,
        sourceCount: adapters.length
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

  if (command === "sources") {
    await runSourcesCommand(config, process.argv.slice(3));
    return;
  }

  process.stdout.write(
    "ai-news-assistant\n\nCommands:\n" +
    "  run      Fetch, analyze, and build today's EPUB from all enabled sources\n" +
    "  serve    Serve /healthz, /daily/latest.json, and /daily/latest.epub\n" +
    "  doctor   Validate directories, LLM settings, sources, and Pandoc\n" +
    "  sources  List and manage persisted non-secret source configuration\n\n" +
    "Source commands:\n" +
    "  sources list\n" +
    "  sources types\n" +
    "  sources add reddit <subreddit>\n" +
    "  sources add <type> <id> '<settings-json>' [display-name]\n" +
    "  sources update <id> '<settings-json>' [display-name]\n" +
    "  sources enable <id>\n" +
    "  sources disable <id>\n"
  );
}

main().catch((error) => {
  logger.child({ component: "cli" }).error("command failed", { error });
  process.exitCode = 1;
});
