import { describe, expect, it } from "vitest";
import type {
  ProjectTodo,
  ProjectTodosResult,
  ScenarioQueryResult,
  TodoManualHistoryEntry,
  TodoManualState,
  TodoManualStatus,
  TodoRuleFinding,
  TodoRuleScanStatus,
  UpdateTodoManualInput,
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
    const scanStatuses: TodoRuleScanStatus[] = ["not_run", "complete", "partial", "failed"];
    const finding: TodoRuleFinding = {
      dedupe_key: "todo-demo-finding-001",
      rule_id: "missing_title",
      subject: { kind: "page", key: "https://demo.example.test/item" },
      title: "页面缺少标题",
      severity: "mid",
      sources: [
        {
          path: "seoPages",
          record_key: "https://demo.example.test/item",
          collected_at: "2026-11-12T08:00:00.000Z",
        },
      ],
      first_seen_at: "2026-11-10T08:00:00.000Z",
      last_seen_at: "2026-11-12T08:00:00.000Z",
    };
    const stateBeforeAbsence: TodoManualState = {
      dedupe_key: finding.dedupe_key,
      status: "done",
      note: "虚构 fixture 的复核备注",
      updated_at: "2026-11-12T08:05:00.000Z",
    };
    const absenceConfirmedAt = "2026-11-12T08:08:00.000Z";
    const stateDuringAbsence: TodoManualState = {
      ...stateBeforeAbsence,
      absence_confirmed_at: absenceConfirmedAt,
    };
    const stateAfterReappearance: TodoManualState = {
      ...stateDuringAbsence,
      status: "pending_review",
      updated_at: "2026-11-12T08:10:00.000Z",
      absence_confirmed_at: null,
    };
    const history: TodoManualHistoryEntry[] = [
      {
        event_id: "event-demo-1",
        dedupe_key: finding.dedupe_key,
        action: "status_changed",
        from_status: "open",
        to_status: "done",
        changed_at: stateBeforeAbsence.updated_at,
      },
      {
        event_id: "event-demo-2",
        dedupe_key: finding.dedupe_key,
        action: "note_changed",
        note: stateBeforeAbsence.note,
        changed_at: stateBeforeAbsence.updated_at,
      },
      {
        event_id: "event-demo-3",
        dedupe_key: finding.dedupe_key,
        action: "rule_reopened",
        from_status: "done",
        to_status: "pending_review",
        rule_id: finding.rule_id,
        absence_confirmed_at: absenceConfirmedAt,
        changed_at: "2026-11-12T08:10:00.000Z",
      },
    ];
    const todo: ProjectTodo = { finding, state: stateAfterReappearance };
    const ignoredTodo: ProjectTodo = {
      finding,
      state: { ...stateBeforeAbsence, status: "ignored" },
    };
    const completeScan: ProjectTodosResult = {
      items: [todo],
      scan: { status: "complete", evaluated_at: "2026-11-12T08:10:00.000Z" },
    };
    const partialScan: ProjectTodosResult = {
      items: [todo],
      scan: { status: "partial", evaluated_at: "2026-11-12T08:11:00.000Z" },
    };
    const ignoredScan: ProjectTodosResult = {
      items: [ignoredTodo],
      scan: { status: "complete", evaluated_at: "2026-11-12T08:12:00.000Z" },
    };
    const updates: UpdateTodoManualInput[] = [
      { dedupe_key: finding.dedupe_key, status: "done" },
      { dedupe_key: finding.dedupe_key, note: "再次复核" },
      { dedupe_key: finding.dedupe_key, status: "ignored", note: null },
    ];

    expect(JSON.parse(JSON.stringify(statuses))).toEqual(["open", "in_progress", "pending_review", "done", "ignored"]);
    expect(JSON.parse(JSON.stringify(scanStatuses))).toEqual(["not_run", "complete", "partial", "failed"]);
    expect(finding.dedupe_key).toBe(stateAfterReappearance.dedupe_key);
    expect(todo.finding.rule_id).toBe("missing_title");
    expect(todo.finding.subject.key).toBe("https://demo.example.test/item");
    expect(todo.finding.sources[0]).toMatchObject({ path: "seoPages", record_key: todo.finding.subject.key });
    expect(todo.finding.sources[0].collected_at).toBe("2026-11-12T08:00:00.000Z");
    expect(history[2]).toMatchObject({ action: "rule_reopened", from_status: "done", to_status: "pending_review" });
    expect(history[2]).toHaveProperty("absence_confirmed_at", absenceConfirmedAt);
    expect(stateDuringAbsence.absence_confirmed_at).toBe(absenceConfirmedAt);
    expect(stateAfterReappearance.absence_confirmed_at).toBeNull();
    expect(completeScan.scan.status).toBe("complete");
    expect(partialScan.items).toHaveLength(1);
    expect(partialScan.scan.status).toBe("partial");
    expect(ignoredScan.items[0]?.state.status).toBe("ignored");
    expect(updates).toHaveLength(3);
    expect(
      JSON.parse(JSON.stringify({ completeScan, partialScan, ignoredScan, stateDuringAbsence, history, updates })),
    ).toEqual({
      completeScan,
      partialScan,
      ignoredScan,
      stateDuringAbsence,
      history,
      updates,
    });
  });
});
