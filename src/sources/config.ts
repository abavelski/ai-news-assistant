import { ConfigurationError } from "../errors.js";

export interface SourceConfig<TSettings = Record<string, unknown>> {
  id: string;
  type: string;
  enabled: boolean;
  displayName: string;
  settingsVersion: number;
  settings: TSettings;
  createdAt: string;
  updatedAt: string;
}

export interface SourceConfigCreateInput {
  id: string;
  type: string;
  enabled?: boolean;
  displayName?: string;
  settingsVersion?: number;
  settings: unknown;
}

export interface SourceConfigUpdateInput {
  displayName?: string;
  settingsVersion?: number;
  settings?: unknown;
}

export interface SourceRunStatus {
  sourceId: string;
  sourceType: string;
  lastAttemptAt: string;
  lastSuccessAt?: string;
  checkpoint?: string;
  discoveredCount: number;
  processedCount: number;
  failedCount: number;
  errorCode?: string;
  errorMessage?: string;
}

export interface SourceSettingDescriptor {
  name: string;
  type: "string" | "integer" | "boolean" | "string-list";
  required: boolean;
  label: string;
  description?: string;
}

export interface SourceTypeDescriptor {
  type: string;
  displayName: string;
  settingsVersion: number;
  settings: SourceSettingDescriptor[];
  secretRequirements: string[];
}

const SOURCE_ID_PATTERN = /^[a-z0-9][a-z0-9:_-]{0,99}$/;
const SETTINGS_SECRET_PATTERN = /(?:secret|password|passwd|token|authorization|cookie|api[_-]?key|client[_-]?secret)/i;
const MAX_SETTINGS_BYTES = 16_384;

export function validateSourceId(value: string): string {
  const normalized = value.trim().toLocaleLowerCase("en-US");
  if (!SOURCE_ID_PATTERN.test(normalized)) {
    throw new ConfigurationError(
      "Source id must be 1-100 lowercase characters using letters, digits, ':', '_' or '-', and must start with a letter or digit."
    );
  }
  return normalized;
}

export function validateSourceDisplayName(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 200) {
    throw new ConfigurationError("Source display name must contain 1-200 characters.");
  }
  return normalized;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype);
}

function assertNoSecretLikeSettings(value: unknown, path = "settings"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSecretLikeSettings(entry, `${path}[${index}]`));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (SETTINGS_SECRET_PATTERN.test(key)) {
      throw new ConfigurationError(
        `Source ${path}.${key} looks like a credential. Keep secrets in the protected process environment, not source settings.`
      );
    }
    assertNoSecretLikeSettings(entry, `${path}.${key}`);
  }
}

export function validateNonSecretSettings(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) throw new ConfigurationError("Source settings must be a JSON object.");
  assertNoSecretLikeSettings(value);
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch (cause) {
    throw new ConfigurationError("Source settings must be JSON-serializable.", { cause });
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_SETTINGS_BYTES) {
    throw new ConfigurationError(`Source settings must not exceed ${MAX_SETTINGS_BYTES} UTF-8 bytes.`);
  }
  return value;
}

export function validateHttpUrl(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ConfigurationError(`${fieldName} must be a non-empty http(s) URL.`);
  }
  const normalized = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch (cause) {
    throw new ConfigurationError(`${fieldName} must be a valid http(s) URL.`, { cause });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ConfigurationError(`${fieldName} must use http:// or https://.`);
  }
  if (parsed.username || parsed.password) throw new ConfigurationError(`${fieldName} must not contain URL credentials.`);
  return normalized.replace(/\/+$/, "");
}
