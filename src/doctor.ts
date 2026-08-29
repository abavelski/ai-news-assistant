import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { assertPipelineConfig, type AppConfig } from "./config.js";

export interface DoctorCheck {
  name: "data-directory" | "output-directory" | "llm-configuration" | "pandoc";
  ok: boolean;
  detail: string;
}

export type CommandExecutor = (
  executable: string,
  args: string[]
) => Promise<{ stdout: string; stderr: string }>;

const execFileAsync = promisify(execFile);

async function defaultCommandExecutor(executable: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(executable, args, { encoding: "utf8" });
  return { stdout: result.stdout, stderr: result.stderr };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function checkWritableDirectory(
  directory: string,
  name: "data-directory" | "output-directory"
): Promise<DoctorCheck> {
  const probePath = path.join(directory, `.doctor-${process.pid}-${randomUUID()}`);
  try {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(probePath, "writable", { encoding: "utf8", flag: "wx" });
    await fs.unlink(probePath);
    return { name, ok: true, detail: `${directory} is writable.` };
  } catch (error) {
    await fs.unlink(probePath).catch(() => undefined);
    return {
      name,
      ok: false,
      detail: `Cannot write to ${directory}: ${errorMessage(error)}`
    };
  }
}

export function checkLlmConfiguration(config: AppConfig): DoctorCheck {
  try {
    assertPipelineConfig(config);
    return {
      name: "llm-configuration",
      ok: true,
      detail: `LLM configured for model ${config.llmModel} at ${config.llmBaseUrl}.`
    };
  } catch (error) {
    return {
      name: "llm-configuration",
      ok: false,
      detail: errorMessage(error)
    };
  }
}

export async function checkPandocAvailability(
  execute: CommandExecutor = defaultCommandExecutor
): Promise<DoctorCheck> {
  try {
    const { stdout } = await execute("pandoc", ["--version"]);
    const version = stdout.split(/\r?\n/, 1)[0]?.trim();
    return {
      name: "pandoc",
      ok: true,
      detail: version || "Pandoc is available."
    };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
    return {
      name: "pandoc",
      ok: false,
      detail: code === "ENOENT"
        ? "Pandoc is not available on PATH. Install Pandoc and ensure the `pandoc` executable is reachable."
        : `Pandoc check failed: ${errorMessage(error)}`
    };
  }
}

export async function runDoctor(
  config: AppConfig,
  execute: CommandExecutor = defaultCommandExecutor
): Promise<{ ok: boolean; checks: DoctorCheck[] }> {
  const checks: DoctorCheck[] = [
    await checkWritableDirectory(config.dataDir, "data-directory"),
    await checkWritableDirectory(config.outputDir, "output-directory"),
    checkLlmConfiguration(config),
    await checkPandocAvailability(execute)
  ];
  return { ok: checks.every((check) => check.ok), checks };
}
