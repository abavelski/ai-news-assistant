import { ConfigurationError } from "../errors.js";
import type { SourceConfigRepository } from "../storage/source-config.js";
import type { SourceConfig, SourceConfigCreateInput, SourceConfigUpdateInput, SourceRunStatus } from "./config.js";
import { validateSourceDisplayName, validateSourceId } from "./config.js";
import { MEDUZA_SETTINGS_VERSION, MEDUZA_SOURCE_TYPE } from "./meduza.js";
import type { SourceRegistry } from "./registry.js";

export interface SourceConfigWithStatus {
  config: SourceConfig;
  status?: SourceRunStatus;
}

export class SourceConfigService {
  constructor(
    private readonly repository: SourceConfigRepository,
    private readonly registry: SourceRegistry,
    private readonly now: () => Date = () => new Date()
  ) {}

  list(): SourceConfig[] {
    return this.repository.list();
  }

  listWithStatus(): SourceConfigWithStatus[] {
    return this.repository.list().map((config) => ({
      config,
      status: this.repository.getRunStatus(config.id)
    }));
  }

  get(id: string): SourceConfig | undefined {
    return this.repository.get(validateSourceId(id));
  }

  create(input: SourceConfigCreateInput): SourceConfig {
    const id = validateSourceId(input.id);
    if (this.repository.get(id)) throw new ConfigurationError(`Source ${id} already exists.`);
    const definition = this.registry.getDefinition(input.type);
    const settingsVersion = input.settingsVersion ?? definition.settingsVersion;
    const displayName = validateSourceDisplayName(input.displayName ?? `${definition.displayName} (${id})`);
    const timestamp = this.now().toISOString();
    const candidate: SourceConfig = {
      id,
      type: definition.type,
      enabled: input.enabled ?? true,
      displayName,
      settingsVersion,
      settings: input.settings as Record<string, unknown>,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    const validated = this.registry.validateConfig(candidate);
    this.repository.insert(validated);
    return validated;
  }

  update(id: string, input: SourceConfigUpdateInput): SourceConfig {
    const normalizedId = validateSourceId(id);
    const existing = this.repository.get(normalizedId);
    if (!existing) throw new ConfigurationError(`Source ${normalizedId} does not exist.`);
    const candidate: SourceConfig = {
      ...existing,
      displayName: input.displayName === undefined ? existing.displayName : validateSourceDisplayName(input.displayName),
      settingsVersion: input.settingsVersion ?? existing.settingsVersion,
      settings: input.settings === undefined ? existing.settings : input.settings as Record<string, unknown>,
      updatedAt: this.now().toISOString()
    };
    const validated = this.registry.validateConfig(candidate);
    this.repository.update(validated);
    return validated;
  }

  setEnabled(id: string, enabled: boolean): SourceConfig {
    const normalizedId = validateSourceId(id);
    const existing = this.repository.get(normalizedId);
    if (!existing) throw new ConfigurationError(`Source ${normalizedId} does not exist.`);
    const candidate = { ...existing, enabled, updatedAt: this.now().toISOString() };
    if (enabled) this.registry.validateConfig(candidate);
    this.repository.update(candidate);
    return candidate;
  }

  listEnabledValidated(): SourceConfig[] {
    const enabled = this.repository.list().filter((source) => source.enabled);
    return enabled.map((source) => this.registry.validateConfig(source));
  }

  bootstrapDefaultMeduza(rssUrl: string): SourceConfig | undefined {
    const existing = this.repository.list();
    if (existing.length > 0) return existing.find((source) => source.id === "meduza");
    return this.create({
      id: "meduza",
      type: MEDUZA_SOURCE_TYPE,
      displayName: "Meduza",
      enabled: true,
      settingsVersion: MEDUZA_SETTINGS_VERSION,
      settings: { rssUrl }
    });
  }

  assertRunnable(): SourceConfig[] {
    const enabled = this.listEnabledValidated();
    if (enabled.length === 0) {
      throw new ConfigurationError("At least one source must be enabled before running the pipeline.");
    }
    return enabled;
  }
}
