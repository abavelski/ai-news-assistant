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
import {
  RedditCandidateBudget,
  RedditSource,
  REDDIT_SETTINGS_VERSION,
  REDDIT_SOURCE_TYPE,
  redditMissingRuntimeSecrets,
  redditRuntimeConfigIssues,
  redditSourceId,
  validateRedditSettings,
  type RedditSettings
} from "./reddit.js";

export interface SourceTypeDefinition<TSettings extends Record<string, unknown> = Record<string, unknown>> {
  type: string;
  displayName: string;
  settingsVersion: number;
  settings: SourceTypeDescriptor["settings"];
  secretRequirements: string[];
  validateSettings(value: unknown, settingsVersion: number): TSettings;
  validateInstance?(config: SourceConfig<TSettings>): void;
  createAdapter(config: SourceConfig<TSettings>, appConfig: AppConfig): SourceAdapter;
  missingRuntimeSecrets?(appConfig: AppConfig): string[];
  runtimeConfigIssues?(appConfig: AppConfig): string[];
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
    const validated = { ...config, type: definition.type, settings };
    definition.validateInstance?.(validated);
    return validated;
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
    const issues = definition.runtimeConfigIssues?.(appConfig) ?? [];
    if (issues.length > 0) {
      throw new ConfigurationError(`Source ${validated.id} runtime configuration is invalid: ${issues.join(" ")}`);
    }
    return definition.createAdapter(validated, appConfig);
  }

  missingRuntimeSecrets(config: SourceConfig, appConfig: AppConfig): string[] {
    const validated = this.validateConfig(config);
    return this.getDefinition(validated.type).missingRuntimeSecrets?.(appConfig) ?? [];
  }

  runtimeConfigIssues(config: SourceConfig, appConfig: AppConfig): string[] {
    const validated = this.validateConfig(config);
    return this.getDefinition(validated.type).runtimeConfigIssues?.(appConfig) ?? [];
  }
}

export function createDefaultSourceRegistry(): SourceRegistry {
  let redditBudget: RedditCandidateBudget | undefined;
  let redditBudgetLimit: number | undefined;
  const getRedditBudget = (config: AppConfig): RedditCandidateBudget => {
    if (!redditBudget || redditBudgetLimit !== config.redditMaxTotalCandidates) {
      redditBudgetLimit = config.redditMaxTotalCandidates;
      redditBudget = new RedditCandidateBudget(config.redditMaxTotalCandidates);
    }
    return redditBudget;
  };

  return new SourceRegistry()
    .register<MeduzaSettings>({
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
    })
    .register<RedditSettings>({
      type: REDDIT_SOURCE_TYPE,
      displayName: "Reddit subreddit",
      settingsVersion: REDDIT_SETTINGS_VERSION,
      settings: [
        { name: "subreddit", type: "string", required: true, label: "Subreddit" },
        { name: "maxDiscoveredPosts", type: "integer", required: true, label: "Maximum posts inspected per run" },
        { name: "minComments", type: "integer", required: true, label: "Minimum comments" },
        { name: "minScore", type: "integer", required: true, label: "Minimum score" },
        { name: "maxDiscussionCandidates", type: "integer", required: true, label: "Maximum discussions materialized" },
        { name: "allowNsfw", type: "boolean", required: true, label: "Allow NSFW posts" },
        { name: "allowedFlairs", type: "string-list", required: true, label: "Allowed flairs" },
        { name: "excludedFlairs", type: "string-list", required: true, label: "Excluded flairs" },
        { name: "maxComments", type: "integer", required: true, label: "Maximum sampled comments" },
        { name: "maxCommentDepth", type: "integer", required: true, label: "Maximum comment depth" },
        { name: "maxCommentChars", type: "integer", required: true, label: "Maximum characters per comment" },
        { name: "maxDiscussionChars", type: "integer", required: true, label: "Maximum aggregate discussion characters" }
      ],
      secretRequirements: ["REDDIT_CLIENT_ID", "REDDIT_CLIENT_SECRET"],
      validateSettings: validateRedditSettings,
      validateInstance: (sourceConfig) => {
        const expected = redditSourceId(sourceConfig.settings.subreddit);
        if (sourceConfig.id !== expected) {
          throw new ConfigurationError(
            `Reddit source id ${sourceConfig.id} does not match subreddit r/${sourceConfig.settings.subreddit}; expected ${expected}.`
          );
        }
      },
      missingRuntimeSecrets: redditMissingRuntimeSecrets,
      runtimeConfigIssues: redditRuntimeConfigIssues,
      createAdapter: (sourceConfig, appConfig) => new RedditSource(appConfig, sourceConfig, {
        budget: getRedditBudget(appConfig)
      })
    });
}
