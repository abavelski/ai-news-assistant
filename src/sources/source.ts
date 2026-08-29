import type { DiscoveredItem } from "../types.js";

export interface NewsSource {
  readonly id: string;
  discover(since: Date): Promise<DiscoveredItem[]>;
}
