import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface RunLockInfo {
  pid: number;
  startedAt: string;
  token: string;
}

export interface PipelineRunLock {
  path: string;
  info: RunLockInfo;
  release(): Promise<void>;
}

export type AcquireRunLockResult =
  | { acquired: true; lock: PipelineRunLock }
  | { acquired: false; holder?: RunLockInfo };

const LOCK_FILE = "pipeline.lock";

function isErrno(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

function parseLockInfo(raw: string): RunLockInfo | undefined {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!Number.isSafeInteger(value.pid) || Number(value.pid) <= 0) return undefined;
    if (typeof value.startedAt !== "string" || Number.isNaN(Date.parse(value.startedAt))) return undefined;
    if (typeof value.token !== "string" || value.token.length < 8) return undefined;
    return { pid: Number(value.pid), startedAt: value.startedAt, token: value.token };
  } catch {
    return undefined;
  }
}

async function readLockInfo(lockPath: string): Promise<RunLockInfo | undefined> {
  try {
    return parseLockInfo(await fs.readFile(lockPath, "utf8"));
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrno(error, "ESRCH");
  }
}

async function releaseOwnedLock(lockPath: string, token: string): Promise<void> {
  const current = await readLockInfo(lockPath);
  if (!current || current.token !== token) return;
  await fs.rm(lockPath, { force: true });
}

export async function acquirePipelineRunLock(
  dataDir: string,
  now: () => Date = () => new Date()
): Promise<AcquireRunLockResult> {
  await fs.mkdir(dataDir, { recursive: true });
  const lockPath = path.join(dataDir, LOCK_FILE);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const info: RunLockInfo = {
      pid: process.pid,
      startedAt: now().toISOString(),
      token: randomUUID()
    };

    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(lockPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(info)}\n`, "utf8");
      await handle.close();
      handle = undefined;
      return {
        acquired: true,
        lock: {
          path: lockPath,
          info,
          release: () => releaseOwnedLock(lockPath, info.token)
        }
      };
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (!isErrno(error, "EEXIST")) throw error;

      const holder = await readLockInfo(lockPath);
      if (holder && processIsRunning(holder.pid)) {
        return { acquired: false, holder };
      }

      try {
        await fs.rm(lockPath);
      } catch (removeError) {
        if (!isErrno(removeError, "ENOENT")) throw removeError;
      }
    }
  }

  return { acquired: false, holder: await readLockInfo(lockPath) };
}
