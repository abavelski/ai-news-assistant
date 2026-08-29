import type { AppConfig } from "../config.js";
import type { EditionArticle, EditorialPlan } from "../types.js";

export interface RenderEditionRequest {
  config: AppConfig;
  editionDate: string;
  plan: EditorialPlan;
  selected: EditionArticle[];
}

export interface RenderedEdition {
  epubPath: string;
  manifestPath: string;
}

export interface EditionRenderer {
  render(request: RenderEditionRequest): Promise<RenderedEdition>;
}
