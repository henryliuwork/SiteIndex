import { describe, expect, it } from "vitest";
import type {
  ScenarioQueryResult,
  TodoManualHistoryEntry,
  TodoManualState,
  TodoManualStatus,
  TodoRuleFinding,
} from "../src";

describe("v0.5 read-model contract", () => {
  it("keeps scenario provenance and quality metadata JSON-serializable", () => {
    const result: ScenarioQueryResult<{ clicks: number }> = {
      data: { clicks: 12 },
      metadata: {
        sources: [{ kind: "google_search_console", label: "搜索表现" }, { kind: "derived" }],
        collected_at: "2026-11-12T08:00:00.000Z",
        missing_fields: ["impressions"],
        quality: "partial",
        anomalies: [{ code: "source_timeout", severity: "warning", message: "数据源响应超时。" }],
      },
    };

    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it("keeps rule output, current human state, and append-only review history separate", () => {
    const statuses: TodoManualStatus[] = ["open", "in_progress", "pending_review", "done", "ignored"];
    const finding: TodoRuleFinding = {
      dedupe_key: "todo-demo-finding-001",
      rule_id: "missing_title",
      subject: { kind: "page", key: "https://demo.example.test/item" },
      title: "页面缺少标题",
      severity: "mid",
      first_seen_at: "2026-11-10T08:00:00.000Z",
      last_seen_at: "2026-11-12T08:00:00.000Z",
    };
    const state: TodoManualState = {
      dedupe_key: finding.dedupe_key,
      status: "ignored",
      note: "虚构 fixture 的复核备注",
      updated_at: "2026-11-12T08:05:00.000Z",
    };
    const history: TodoManualHistoryEntry[] = [
      {
        event_id: "event-demo-1",
        dedupe_key: finding.dedupe_key,
        action: "status_changed",
        from_status: "open",
        to_status: "ignored",
        changed_at: state.updated_at,
      },
      {
        event_id: "event-demo-2",
        dedupe_key: finding.dedupe_key,
        action: "note_changed",
        note: state.note,
        changed_at: state.updated_at,
      },
    ];

    expect(JSON.parse(JSON.stringify(statuses))).toEqual(["open", "in_progress", "pending_review", "done", "ignored"]);
    expect(finding.dedupe_key).toBe(state.dedupe_key);
    expect(JSON.parse(JSON.stringify({ finding, state, history }))).toEqual({ finding, state, history });
  });
});
