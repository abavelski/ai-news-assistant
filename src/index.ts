import { assertPipelineConfig, loadConfig } from "./config.js";
import { startDeliveryServer } from "./delivery/server.js";
import { OpenAiCompatibleProvider } from "./llm/openai-compatible.js";
import { runPipeline } from "./pipeline.js";
import { MeduzaSource } from "./sources/meduza.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const command = process.argv[2] ?? "help";

  if (command === "serve") {
    startDeliveryServer(config);
    return;
  }

  if (command === "run") {
    assertPipelineConfig(config);
    const source = new MeduzaSource(config);
    const llm = new OpenAiCompatibleProvider(config);
    const result = await runPipeline(config, source, llm);
    console.log(`[pipeline] generated ${result.epubPath} with ${result.selectedCount} selected stories`);
    return;
  }

  console.log(`ai-news-assistant\n\nCommands:\n  run    Fetch, analyze, and build today's EPUB\n  serve  Serve /daily/latest.json and /daily/latest.epub\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
