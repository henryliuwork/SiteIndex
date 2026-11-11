import { TITLE_BAR_OVERLAY_COLOR_CHANNEL } from "../shared/titlebar-overlay-channel.js";
import { WORDPRESS_CREDENTIAL_CHANNELS } from "../shared/wordpress-credential-channels.js";
import type { WordPressCredentialInput, WordPressCredentialStatus } from "../shared/wordpress-credential-types.js";

export interface WindowApiTransport {
  send(channel: string, payload: unknown): void;
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
}

export interface SiteIndexWindowApi {
  /** Updates the native Windows title bar background; pass a six digit CSS hex color. */
  setTitleBarOverlayColor(color: string): void;
  /** Desktop-only credential bridge; never returns credentials to the renderer. */
  wordpressCredentials: {
    status(siteUrl: string): Promise<WordPressCredentialStatus>;
    save(input: WordPressCredentialInput): Promise<void>;
    clear(siteUrl: string): Promise<void>;
  };
}

export function createWindowApi(transport: WindowApiTransport): SiteIndexWindowApi {
  return {
    setTitleBarOverlayColor: (color) => transport.send(TITLE_BAR_OVERLAY_COLOR_CHANNEL, color),
    wordpressCredentials: {
      status: (siteUrl) =>
        transport.invoke(WORDPRESS_CREDENTIAL_CHANNELS.status, siteUrl) as Promise<WordPressCredentialStatus>,
      save: (input) => transport.invoke(WORDPRESS_CREDENTIAL_CHANNELS.save, input) as Promise<void>,
      clear: (siteUrl) => transport.invoke(WORDPRESS_CREDENTIAL_CHANNELS.clear, siteUrl) as Promise<void>,
    },
  };
}
