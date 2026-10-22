import type { SiteIndexApi } from "@siteindex/shared";

/** M1 骨架默认值；B2 会换成 fixtures 驱动的完整 mock。 */
export function createMockApi(): SiteIndexApi {
  const namespace = new Proxy({}, { get: () => async () => undefined });
  return new Proxy({}, { get: () => namespace }) as unknown as SiteIndexApi;
}
