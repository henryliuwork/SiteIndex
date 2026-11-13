import { describe, expect, it } from "vitest";
import type {
  GscAuthorizationStatus,
  GscPropertyListData,
  GscSyncResult,
  ScenarioQueryResult,
  SiteIndexApi,
} from "../src";
import { API_INVOKE_METHODS, PENDING_HANDLERS } from "../src";

const GSC_METHODS = [
  "gsc.status",
  "gsc.connect",
  "gsc.disconnect",
  "gsc.listProperties",
  "gsc.selectProperty",
  "gsc.sync",
] as const;

describe("GSC contract", () => {
  it("keeps the GSC namespace optional for older bridges and registers its pending handlers", () => {
    const oldBridge: Pick<SiteIndexApi, "gsc"> = {};

    expect(oldBridge.gsc).toBeUndefined();
    for (const method of GSC_METHODS) {
      expect(API_INVOKE_METHODS.filter((entry) => entry === method)).toHaveLength(1);
      expect(PENDING_HANDLERS).toContain(method);
    }
  });

  it("defines local authorization state without exposing tokens or account identifiers", () => {
    const status: GscAuthorizationStatus = {
      state: "connected",
    };
    const disconnected: GscAuthorizationStatus = {
      state: "reauthorization_required",
      reason: "refresh_token_rejected",
    };

    expect(JSON.parse(JSON.stringify(status))).toEqual({ state: "connected" });
    expect(JSON.parse(JSON.stringify(disconnected))).toEqual({
      state: "reauthorization_required",
      reason: "refresh_token_rejected",
    });
    for (const candidate of [status, disconnected]) {
      expect(candidate).not.toHaveProperty("access_token");
      expect(candidate).not.toHaveProperty("refresh_token");
      expect(candidate).not.toHaveProperty("email");
    }
  });

  it("represents available properties, explicit selection, provenance and quality metadata", () => {
    const properties: ScenarioQueryResult<GscPropertyListData> = {
      data: {
        properties: [
          { site_url: "sc-domain:fictional.example.test", permission_level: "siteOwner" },
          { site_url: "https://shop.fictional.example.test/", permission_level: "siteFullUser" },
        ],
        selected_site_url: "sc-domain:fictional.example.test",
      },
      metadata: {
        sources: [{ kind: "google_search_console", label: "Search Console 属性列表" }],
        collected_at: "2026-11-13T08:00:00.000Z",
        missing_fields: [],
        quality: "complete",
        anomalies: [],
      },
    };

    expect(JSON.parse(JSON.stringify(properties))).toEqual(properties);
  });

  it("models initial 90-day and incremental sync while requiring failed history to be preserved", () => {
    const initial: GscSyncResult = {
      state: "partial",
      mode: "initial_90_days",
      history_effect: "merged",
      records_received: 142,
      records_written: 142,
      metadata: {
        data_source: "google_search_console",
        property_site_url: "sc-domain:fictional.example.test",
        requested_at: "2026-11-13T08:00:00.000Z",
        collected_at: "2026-11-13T08:00:02.000Z",
        data_through: "2026-11-10",
        requested_range: { start_date: "2026-08-16", end_date: "2026-11-13" },
        missing_ranges: [{ start_date: "2026-11-11", end_date: "2026-11-13", reason: "not_yet_available" }],
        missing_fields: [],
        quality: "partial",
        anomalies: [{ code: "GSC_DATA_DELAY", severity: "warning", message: "最新日期的数据尚未可用。" }],
      },
    };
    const failedIncremental: GscSyncResult = {
      state: "failed",
      mode: "incremental",
      history_effect: "preserved",
      records_received: 0,
      records_written: 0,
      error: { code: "network_error", message: "无法连接 Search Console，历史数据保持不变。" },
      metadata: {
        data_source: "google_search_console",
        property_site_url: "sc-domain:fictional.example.test",
        requested_at: "2026-11-14T08:00:00.000Z",
        collected_at: null,
        data_through: "2026-11-10",
        requested_range: { start_date: "2026-11-08", end_date: "2026-11-10" },
        missing_ranges: [],
        missing_fields: ["daily_metrics"],
        quality: "unreliable",
        anomalies: [{ code: "GSC_API_UNAVAILABLE", severity: "unreliable", message: "属性指标暂时无法读取。" }],
      },
    };

    expect(initial.mode).toBe("initial_90_days");
    expect(initial.history_effect).toBe("merged");
    expect(failedIncremental.mode).toBe("incremental");
    expect(failedIncremental.history_effect).toBe("preserved");
    expect(JSON.parse(JSON.stringify({ initial, failedIncremental }))).toEqual({ initial, failedIncremental });
  });
});
