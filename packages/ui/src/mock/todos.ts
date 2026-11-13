import type { ProjectTodosResult, SiteIndexApi, TodoManualHistoryEntry, TodoManualState, UpdateTodoManualInput } from "@siteindex/shared";
import { clone } from "./context";

const demoResult: ProjectTodosResult = {
  scan: { status: "complete", evaluated_at: "2026-11-13T08:00:00.000Z" },
  items: [
    {
      finding: {
        dedupe_key: "demo:inventory.stock-mismatch:DEMO001CP01",
        rule_id: "inventory.stock-mismatch",
        subject: { kind: "sku", key: "DEMO001CP01", label: "演示商品 DEMO001CP01" },
        title: "库存状态与 Feed 记录不一致",
        detail: "虚构样例：Feed 与最近一次库存视图对该商品给出了不同的状态。",
        severity: "high",
        sources: [
          { path: "skus", record_key: "DEMO001CP01", collected_at: "2026-11-13T07:58:00.000Z" },
          { path: "skuStockView", record_key: "DEMO001CP01", collected_at: "2026-11-13T07:59:00.000Z" },
        ],
        first_seen_at: "2026-11-10T08:00:00.000Z",
        last_seen_at: "2026-11-13T08:00:00.000Z",
      },
      state: { dedupe_key: "demo:inventory.stock-mismatch:DEMO001CP01", status: "open", note: null, updated_at: "2026-11-13T08:00:00.000Z" },
    },
    {
      finding: {
        dedupe_key: "demo:seo.title-review:https://demo-store.example.test/products/demo-item-001",
        rule_id: "seo.title-review",
        subject: { kind: "url", key: "https://demo-store.example.test/products/demo-item-001", label: "演示商品页面" },
        title: "页面标题需要复核",
        detail: "虚构样例：页面标题与项目内核心关键词的表达不一致。",
        severity: "mid",
        sources: [
          { path: "seoPages", record_key: "https://demo-store.example.test/products/demo-item-001", collected_at: "2026-11-13T07:40:00.000Z" },
        ],
        first_seen_at: "2026-11-09T08:00:00.000Z",
        last_seen_at: "2026-11-12T09:30:00.000Z",
      },
      state: { dedupe_key: "demo:seo.title-review:https://demo-store.example.test/products/demo-item-001", status: "pending_review", note: "等待内容负责人确认新版标题。", updated_at: "2026-11-12T10:00:00.000Z" },
    },
    {
      finding: {
        dedupe_key: "demo:content.blog-schema:demo-guide",
        rule_id: "content.blog-schema",
        subject: { kind: "blog", key: "demo-guide", label: "演示指南文章" },
        title: "文章结构化数据待核对",
        detail: "虚构样例：文章索引中的 schema 检查结果需要复核。",
        severity: "low",
        sources: [
          { path: "blogIndex", record_key: "demo-guide", collected_at: "2026-11-12T11:20:00.000Z" },
        ],
        first_seen_at: "2026-11-08T12:00:00.000Z",
        last_seen_at: "2026-11-12T11:20:00.000Z",
      },
      state: { dedupe_key: "demo:content.blog-schema:demo-guide", status: "pending_review", note: "虚构记录：规则重新匹配，等待再次复核。", updated_at: "2026-11-12T15:00:00.000Z" },
    },
    {
      finding: {
        dedupe_key: "demo:inventory.price-gap:DEMO002CP01",
        rule_id: "inventory.price-gap",
        subject: { kind: "sku", key: "DEMO002CP01", label: "演示商品 DEMO002CP01" },
        title: "价格历史存在日期缺口",
        detail: "虚构样例：当前可用的价格历史未覆盖全部预期日期。",
        severity: "mid",
        sources: [
          { path: "eventsDir", record_key: "DEMO002CP01/2026-11.jsonl", collected_at: "2026-11-11T06:00:00.000Z" },
        ],
        first_seen_at: "2026-11-07T08:00:00.000Z",
        last_seen_at: "2026-11-11T06:00:00.000Z",
      },
      state: { dedupe_key: "demo:inventory.price-gap:DEMO002CP01", status: "ignored", note: "虚构记录：当前阶段暂不跟进价格历史。", updated_at: "2026-11-11T08:00:00.000Z" },
    },
  ],
};

const demoHistory: Record<string, TodoManualHistoryEntry[]> = {
  "demo:inventory.stock-mismatch:DEMO001CP01": [
    { event_id: "demo-event-stock-1", dedupe_key: "demo:inventory.stock-mismatch:DEMO001CP01", action: "status_changed", from_status: null, to_status: "open", changed_at: "2026-11-10T08:00:00.000Z" },
    { event_id: "demo-event-stock-2", dedupe_key: "demo:inventory.stock-mismatch:DEMO001CP01", action: "note_changed", note: "等待下一次同步复核。", changed_at: "2026-11-10T09:00:00.000Z" },
  ],
  "demo:seo.title-review:https://demo-store.example.test/products/demo-item-001": [
    { event_id: "demo-event-seo-1", dedupe_key: "demo:seo.title-review:https://demo-store.example.test/products/demo-item-001", action: "status_changed", from_status: "open", to_status: "pending_review", changed_at: "2026-11-12T10:00:00.000Z" },
  ],
  "demo:content.blog-schema:demo-guide": [
    { event_id: "demo-event-blog-1", dedupe_key: "demo:content.blog-schema:demo-guide", action: "status_changed", from_status: "open", to_status: "done", changed_at: "2026-11-12T14:00:00.000Z" },
    { event_id: "demo-event-blog-2", dedupe_key: "demo:content.blog-schema:demo-guide", action: "rule_reopened", from_status: "done", to_status: "pending_review", rule_id: "content.blog-schema", absence_confirmed_at: "2026-11-11T08:00:00.000Z", changed_at: "2026-11-12T15:00:00.000Z" },
  ],
  "demo:inventory.price-gap:DEMO002CP01": [],
};

export function createTodosMock(): NonNullable<SiteIndexApi["todos"]> {
  let state: ProjectTodosResult = clone(demoResult);
  const history = clone(demoHistory);
  let eventNumber = 0;

  return {
    list: async () => clone(state),
    update: async (_projectId, input: UpdateTodoManualInput) => {
      const index = state.items.findIndex(({ finding }) => finding.dedupe_key === input.dedupe_key);
      if (index < 0) throw new Error("演示待办不存在。");
      const current = state.items[index]!;
      const nextState: TodoManualState = {
        ...current.state,
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.note === undefined ? {} : { note: input.note }),
        updated_at: "2026-11-13T08:30:00.000Z",
      };
      const events: TodoManualHistoryEntry[] = [];
      if (input.status !== undefined && input.status !== current.state.status) {
        events.push({ event_id: `demo-event-${++eventNumber}`, dedupe_key: input.dedupe_key, action: "status_changed", from_status: current.state.status, to_status: input.status, changed_at: nextState.updated_at });
      }
      if (input.note !== undefined && input.note !== current.state.note) {
        events.push({ event_id: `demo-event-${++eventNumber}`, dedupe_key: input.dedupe_key, action: "note_changed", note: input.note, changed_at: nextState.updated_at });
      }
      state = { ...state, items: state.items.map((item, itemIndex) => itemIndex === index ? { ...item, state: nextState } : item) };
      history[input.dedupe_key] = [...(history[input.dedupe_key] ?? []), ...events];
      return clone(nextState);
    },
    history: async (_projectId, dedupeKey) => clone(history[dedupeKey] ?? []),
  };
}
