import type { SiteIndexApi } from "@siteindex/shared";
import { reply } from "./context";

export function createAppMock(): SiteIndexApi["app"] {
  return { version: () => reply("0.1.0-mock"), platform: () => reply("win32") };
}
