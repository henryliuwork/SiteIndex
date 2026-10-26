import type { SiteIndexApi } from "@siteindex/shared";
import { delay, reply } from "./context";

export function createShellMock(): SiteIndexApi["shell"] {
  return {
    openPath: () => reply(undefined),
    openExternal: () => reply(undefined),
    copyText: async (text) => {
      await delay();
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) await navigator.clipboard.writeText(text).catch(() => undefined);
    },
  };
}
