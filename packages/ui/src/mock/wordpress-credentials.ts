export interface MockWordPressCredentialInput {
  siteUrl: string;
  username: string;
  applicationPassword: string;
}

export type MockWordPressCredentialStatus =
  | { state: "configured" }
  | { state: "not_configured" }
  | { state: "needs_reentry" }
  | { state: "unavailable" };

export interface MockWordPressCredentialsBridge {
  status(siteUrl: string): Promise<MockWordPressCredentialStatus>;
  save(input: MockWordPressCredentialInput): Promise<void>;
  clear(siteUrl: string): Promise<void>;
}

function normalizedOrigin(siteUrl: string): string {
  const url = new URL(siteUrl);
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password) throw new Error("请输入 HTTPS 网站地址。");
  return url.origin;
}

/** Browser demo bridge. It keeps status only; credential values are discarded immediately. */
export function createMockWordPressCredentialsBridge(): MockWordPressCredentialsBridge {
  const statuses = new Map<string, MockWordPressCredentialStatus>();
  return {
    async status(siteUrl) {
      return statuses.get(normalizedOrigin(siteUrl)) ?? { state: "not_configured" };
    },
    async save({ siteUrl }) {
      statuses.set(normalizedOrigin(siteUrl), { state: "configured" });
    },
    async clear(siteUrl) {
      statuses.delete(normalizedOrigin(siteUrl));
    },
  };
}
