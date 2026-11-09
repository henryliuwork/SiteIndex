import { TITLE_BAR_OVERLAY_COLOR_CHANNEL } from "../shared/titlebar-overlay-channel.js";

export interface SiteIndexWindowApi {
  /** Updates the native Windows title bar background; pass a six digit CSS hex color. */
  setTitleBarOverlayColor(color: string): void;
}

export function createWindowApi(send: (channel: string, payload: unknown) => void): SiteIndexWindowApi {
  return {
    setTitleBarOverlayColor: (color) => send(TITLE_BAR_OVERLAY_COLOR_CHANNEL, color),
  };
}
