import type { SiteIndexApi } from "@siteindex/shared";

const demoProperties = [
  { site_url: "sc-domain:demo.example.test", permission_level: "siteOwner" },
  { site_url: "https://store.demo.example.test/", permission_level: "siteFullUser" },
] as const;

export function createGscMock(): NonNullable<SiteIndexApi["gsc"]> {
  let state: "not_configured" | "disconnected" | "connected" = "not_configured";
  const selected = new Map<string, string | null>();

  return {
    status: async () => ({ state }),
    connect: async () => {
      state = "connected";
      return { state };
    },
    disconnect: async () => {
      state = "disconnected";
      return { state };
    },
    listProperties: async (projectId) => ({
      data: state === "connected" ? {
        properties: [...demoProperties],
        selected_site_url: selected.get(projectId) ?? null,
      } : null,
      metadata: {
        sources: [{ kind: "google_search_console", label: "Search Console 虚构演示数据" }],
        collected_at: "2026-11-13T08:00:00.000Z",
        missing_fields: [],
        quality: "complete",
        anomalies: [],
      },
    }),
    selectProperty: async (projectId, siteUrl) => {
      if (state !== "connected") throw new Error("请先连接演示 Search Console。");
      if (siteUrl !== null && !demoProperties.some((property) => property.site_url === siteUrl)) {
        throw new Error("所选演示属性不存在。");
      }
      selected.set(projectId, siteUrl);
      return { site_url: siteUrl };
    },
    sync: async (projectId, input) => {
      const propertySiteUrl = selected.get(projectId);
      if (state !== "connected" || !propertySiteUrl) throw new Error("请先连接并明确选择一个演示属性。");
      return {
        state: "partial",
        mode: input.mode,
        history_effect: "merged",
        records_received: 18,
        records_written: 18,
        metadata: {
          data_source: "google_search_console",
          property_site_url: propertySiteUrl,
          requested_at: "2026-11-13T08:00:00.000Z",
          collected_at: "2026-11-13T08:00:02.000Z",
          data_through: "2026-11-10",
          requested_range: input.mode === "initial_90_days"
            ? { start_date: "2026-08-16", end_date: "2026-11-13" }
            : { start_date: "2026-11-08", end_date: "2026-11-10" },
          missing_ranges: [{ start_date: "2026-11-11", end_date: "2026-11-13", reason: "not_yet_available" }],
          missing_fields: [],
          quality: "partial",
          anomalies: [{ code: "GSC_DATA_DELAY", severity: "warning", message: "虚构演示：最新日期的数据尚未可用。" }],
        },
      };
    },
  };
}
