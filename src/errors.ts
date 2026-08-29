export interface AppErrorOptions extends ErrorOptions {
  context?: Record<string, unknown>;
}

export class AppError extends Error {
  readonly code: string;
  readonly context?: Record<string, unknown>;

  constructor(message: string, code: string, options: AppErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.context = options.context;
  }
}

export class ConfigurationError extends AppError {
  constructor(message: string, options?: AppErrorOptions) {
    super(message, "CONFIGURATION_ERROR", options);
  }
}

export class FetchError extends AppError {
  constructor(message: string, options?: AppErrorOptions) {
    super(message, "FETCH_ERROR", options);
  }
}

export class ExtractionError extends AppError {
  constructor(message: string, options?: AppErrorOptions) {
    super(message, "EXTRACTION_ERROR", options);
  }
}

export class LlmError extends AppError {
  constructor(message: string, options?: AppErrorOptions) {
    super(message, "LLM_ERROR", options);
  }
}

export class RenderingError extends AppError {
  constructor(message: string, options?: AppErrorOptions) {
    super(message, "RENDERING_ERROR", options);
  }
}
