import type { AppConfig } from "../config.js";
import { ConfigurationError } from "../errors.js";
import type { SourceAdapter } from "./source.js";
import type { SourceConfig, SourceTypeDescriptor } from "./config.js";
import { validateNonSecretSettings } from "./config.js";
import {
  MeduzaSource,
  MEDUZA_SETTINGS_VERSION,
  MEDUZA_SOURCE_TYPE,
  validateMeduzaSettings,
  type MeduzaSettings
} from "./meduza.js";

export interface SourceTypeDefinition<TSettings extends Record<string, unknown> = Record<string, unknown>> {
  type: string;
  displayName: string;
  settingsVersion: number;
  settings: SourceTypeDescriptor["settings"];
  secretRequirements: string[];
  validateSettings(value: unknown, settingsVersion: number): TSettings;
  createAdapter(config: SourceConfig<TSettings>, appConfig: AppConfig): SourceAdapter;
  missingRuntimeSecrets?(appConfig: AppConfig): string[];
}

export class SourceRegistry {
  private readonly definitions = new Map<string, SourceTypeDefinition>();

  register<TSettings extends Record<string, unknown>>(definition: SourceTypeDefinition<TSettings>): this {
    const type = definition.type.trim().toLocaleLowerCase("en-US");
    if (!type) throw new ConfigurationError("Source type must not be empty.");
    if (this.definitions.has(type)) throw new ConfigurationError(`Source type ${type} is already registered.`);
    this.definitions.set(type, definition as SourceTypeDefinition);
    return this;
  }

  listTypes(): SourceTypeDescriptor[] {
    return [...this.definitions.values()]
      .map((definition) => ({
        type: definition.type,
        displayName: definition.displayName,
        settingsVersion: definition.settingsVersion,
        settings: definition.settings.map((entry) => ({ ...entry })),
        secretRequirements: [...definition.secretRequirements]
      }))
      .sort((left, right) => left.type.localeCompare(right.type));
  }

  getDefinition(type: string): SourceTypeDefinition {
    const normalized = type.trim().toLocaleLowerCase("en-US");
    const definition = this.definitions.get(normalized);
    if (!definition) throw new ConfigurationError(`Unknown source type ${JSON.stringify(type)}.`);
    return definition;
  }

  validateConfig(config: SourceConfig): SourceConfig {
    const definition = this.getDefinition(config.type);
    validateNonSecretSettings(config.settings);
    const settings = definition.validateSettings(config.settings, config.settingsVersion);
    return { ...config, type: definition.type, settings };
  }

  createAdapter(config: SourceConfig, appConfig: AppConfig): SourceAdapter {
    const validated = this.validateConfig(config);
    const definition = this.getDefinition(validated.type);
    const missing = definition.missingRuntimeSecrets?.(appConfig) ?? [];
    if (missing.length > 0) {
      throw new ConfigurationError(
        `Source ${validated.id} requires missing protected environment settings: ${missing.join(", ")}.`
      );
    }
    return definition.createAdapter(validated, appConfig);
  }

  missingRuntimeSecrets(config: SourceConfig, appConfig: AppConfig): string[] {
    const validated = this.validateConfig(config);
    return this.getDefinition(validated.type).missingRuntimeSecrets?.(appConfig) ?? [];
  }
}

export function createDefaultSourceRegistry(): SourceRegistry {
  return new SourceRegistry().register<MeduzaSettings>({
    type: MEDUZA_SOURCE_TYPE,
    displayName: "Meduza",
    settingsVersion: MEDUZA_SETTINGS_VERSION,
    settings: [{
      name: "rssUrl",
      type: "string",
      required: true,
      label: "RSS URL",
      description: "Meduza RSS feed URL used for discovery."
    }],
    secretRequirements: [],
    validateSettings: validateMeduzaSettings,
    createAdapter: (sourceConfig, appConfig) => new MeduzaSource(appConfig, sourceConfig)
  });
}
