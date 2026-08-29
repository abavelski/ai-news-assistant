export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogContext = Record<string, unknown>;
export type LogSink = (line: string, level: LogLevel) => void;

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

let configuredLevel: LogLevel = "info";

const SENSITIVE_KEY = /(?:api[_-]?key|authorization|cookie|password|secret|token)/i;
const BEARER_VALUE = /\bBearer\s+[^\s,;"']+/gi;
const LABELED_SECRET = /\b(api[_-]?key|authorization|password|secret|token)(\s*[:=]\s*)[^\s,;"']+/gi;

export function isLogLevel(value: string): value is LogLevel {
  return value === "debug" || value === "info" || value === "warn" || value === "error";
}

export function configureLogging(level: LogLevel): void {
  configuredLevel = level;
}

function redactString(value: string): string {
  return value
    .replace(BEARER_VALUE, "Bearer [REDACTED]")
    .replace(LABELED_SECRET, (_match, label: string, separator: string) => `${label}${separator}[REDACTED]`);
}

function serializeValue(value: unknown, key?: string): unknown {
  if (key && SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return undefined;

  if (value instanceof Error) {
    const output: Record<string, unknown> = {
      name: value.name,
      message: redactString(value.message)
    };
    if (value.stack) output.stack = redactString(value.stack);
    if ("code" in value) output.code = serializeValue((value as Error & { code?: unknown }).code, "code");
    if ("context" in value) output.context = serializeValue((value as Error & { context?: unknown }).context, "context");
    if (value.cause) output.cause = serializeValue(value.cause, "cause");
    return output;
  }

  if (Array.isArray(value)) return value.map((entry) => serializeValue(entry));

  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      const serialized = serializeValue(entryValue, entryKey);
      if (serialized !== undefined) output[entryKey] = serialized;
    }
    return output;
  }

  return redactString(String(value));
}

function defaultSink(line: string, level: LogLevel): void {
  const stream = level === "warn" || level === "error" ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
}

export class Logger {
  constructor(
    private readonly baseContext: LogContext = {},
    private readonly options: { level?: LogLevel; sink?: LogSink } = {}
  ) {}

  child(context: LogContext): Logger {
    return new Logger({ ...this.baseContext, ...context }, this.options);
  }

  debug(message: string, context?: LogContext): void {
    this.emit("debug", message, context);
  }

  info(message: string, context?: LogContext): void {
    this.emit("info", message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.emit("warn", message, context);
  }

  error(message: string, context?: LogContext): void {
    this.emit("error", message, context);
  }

  private emit(level: LogLevel, message: string, context: LogContext = {}): void {
    const minimumLevel = this.options.level ?? configuredLevel;
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[minimumLevel]) return;

    const serializedContext = serializeValue({ ...this.baseContext, ...context }) as Record<string, unknown>;
    const record = {
      ...serializedContext,
      timestamp: new Date().toISOString(),
      level,
      message: redactString(message)
    };
    (this.options.sink ?? defaultSink)(JSON.stringify(record), level);
  }
}

export const logger = new Logger();
