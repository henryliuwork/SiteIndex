import type { SiteIndexApi } from "@siteindex/shared";
import { clone, designScreenshots, designTokens, reply } from "./context";

export function createDesignMock(): SiteIndexApi["design"] {
  return { get: (id) => reply({ tokens: clone(designTokens), screenshots: designScreenshots(id) }) };
}
