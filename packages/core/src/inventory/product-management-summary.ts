import type {
  InventoryEvent, InventoryLatest, InventorySummary, ISODate, SkuRecord, SkuStockFilters,
  SkuStockView, StockStatus,
} from "@siteindex/shared";

type Metric = NonNullable<SkuStockFilters["summary_metric"]>;
type MemberState = StockStatus | "absent" | "unavailable";
type RowFlags = Record<Metric, boolean | null>;
type Summary = NonNullable<InventorySummary["product_management"]>;

export interface ProductManagementResult {
  summary: Summary;
  matches(sku: string, metric: Metric): boolean;
}

function dateAtOffset(date: ISODate, offset: number): ISODate {
  const result = new Date(`${date}T00:00:00.000Z`);
  result.setUTCDate(result.getUTCDate() + offset);
  return result.toISOString().slice(0, 10);
}

function validDate(value: string, asOf: ISODate): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))
    && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value && value <= asOf;
}

function isStockStatus(value: unknown): value is StockStatus {
  return value === "in_stock" || value === "out_of_stock" || value === "preorder" || value === "unknown";
}

function groupStatus(states: readonly StockStatus[]): StockStatus {
  if (states.includes("in_stock")) return "in_stock";
  if (states.length && states.every((state) => state === "out_of_stock")) return "out_of_stock";
  if (states.includes("preorder")) return "preorder";
  return "unknown";
}

function memberHistory(
  sku: string, asOf: ISODate, latest: InventoryLatest | undefined, record: SkuRecord | undefined,
  events: readonly InventoryEvent[],
): MemberState[] {
  if (!latest || !record || !validDate(latest.since, asOf) || !validDate(record.first_seen, asOf)
    || latest.since < record.first_seen || !isStockStatus(latest.stock_status)) {
    return Array<MemberState>(30).fill("unavailable");
  }
  const byDate = new Map<ISODate, InventoryEvent[]>();
  for (const event of events) {
    if (event.sku !== sku || event.date > asOf) continue;
    const dayEvents = byDate.get(event.date) ?? [];
    dayEvents.push(event);
    byDate.set(event.date, dayEvents);
  }
  const history = Array<MemberState>(30).fill("unavailable");
  let state: MemberState = latest.stock_status;
  for (let offset = 0; offset < 30; offset += 1) {
    const date = dateAtOffset(asOf, -offset);
    history[29 - offset] = date < record.first_seen ? "absent" : state;
    const dayEvents = byDate.get(date) ?? [];
    for (const event of [...dayEvents].reverse()) {
      if (event.type === "stock_change") state = isStockStatus(event.from) ? event.from : "unavailable";
      else if (event.type === "new_sku" || event.type === "restored_sku") state = "absent";
      else if (event.type === "removed_sku") state = "unavailable";
    }
    // A changed `since` without its source event cannot establish the earlier state.
    if (date === latest.since && date > record.first_seen && !dayEvents.some((event) =>
      event.type === "stock_change" || event.type === "new_sku" || event.type === "restored_sku")) {
      state = "unavailable";
    }
  }
  return history;
}

function groupHistory(histories: readonly MemberState[][]): MemberState[] {
  return Array.from({ length: 30 }, (_, day) => {
    const states = histories.map((history) => history[day] ?? "unavailable");
    if (states.includes("unavailable")) return "unavailable";
    const present = states.filter((state): state is StockStatus => state !== "absent" && state !== "unavailable");
    return present.length ? groupStatus(present) : "absent";
  });
}

function directStockFlips(history: readonly MemberState[]): boolean | null {
  let changes = 0;
  let uncertain = false;
  for (let day = 1; day < history.length; day += 1) {
    const previous = history[day - 1];
    const current = history[day];
    if (previous === "unavailable" || current === "unavailable") { uncertain = true; continue; }
    if ((previous === "in_stock" && current === "out_of_stock")
      || (previous === "out_of_stock" && current === "in_stock")) changes += 1;
  }
  return changes >= 2 ? true : uncertain ? null : false;
}

/** Query-only metrics over the same default parent/independent rows used by inventory.listSkus. */
export function productManagementSummary(input: {
  rows: readonly SkuStockView[];
  childrenByParent: ReadonlyMap<string, readonly SkuStockView[]>;
  skus: readonly SkuRecord[];
  latest: readonly InventoryLatest[];
  events: readonly InventoryEvent[];
  asOf: ISODate | null;
  historyComplete: boolean;
  todayEventsComplete: boolean;
}): ProductManagementResult {
  const { rows, childrenByParent, events, asOf } = input;
  const latestBySku = new Map(input.latest.map((row) => [row.sku, row]));
  const recordsBySku = new Map(input.skus.map((row) => [row.sku, row]));
  const eventsBySku = new Map<string, InventoryEvent[]>();
  for (const event of events) {
    const list = eventsBySku.get(event.sku) ?? [];
    list.push(event);
    eventsBySku.set(event.sku, list);
  }
  const flags = new Map<string, RowFlags>();
  for (const row of rows) {
    // A real feed parent is a display key, never a stock member when it has children.
    const members = row.is_parent ? childrenByParent.get(row.sku) ?? [] : [row];
    const changed = asOf === null || !input.todayEventsComplete ? null : members.some((member) =>
      (eventsBySku.get(member.sku) ?? []).some((event) => event.date === asOf && event.type === "stock_change"));
    let longOos: boolean | null = null;
    let volatile: boolean | null = null;
    if (asOf !== null) {
      if (row.stock_status !== "out_of_stock") longOos = false;
      else {
        const latestMembers = members.map((member) => latestBySku.get(member.sku));
        longOos = latestMembers.some((latest, index) => {
          const member = members[index];
          const record = member && recordsBySku.get(member.sku);
          return !latest || !record || latest.stock_status !== "out_of_stock"
            || latest.stock_status !== member?.stock_status || !validDate(latest.since, asOf)
            || !validDate(record.first_seen, asOf) || latest.since < record.first_seen;
        })
          ? null : latestMembers.every((latest) => latest!.since <= dateAtOffset(asOf, -6));
      }
      const histories = members.map((member) => memberHistory(member.sku, asOf,
        latestBySku.get(member.sku), recordsBySku.get(member.sku), eventsBySku.get(member.sku) ?? []));
      volatile = input.historyComplete && histories.length ? directStockFlips(groupHistory(histories)) : null;
    }
    flags.set(row.sku, {
      in_stock: asOf === null ? null : row.stock_status === "in_stock",
      changed,
      out_of_stock_7d: longOos,
      fluctuating_30d: volatile,
    });
  }
  const count = (metric: Metric): number | null => {
    if (asOf === null || [...flags.values()].some((row) => row[metric] === null)) return null;
    return [...flags.values()].filter((row) => row[metric]).length;
  };
  const counts = {
    in_stock: count("in_stock"), changed: count("changed"),
    out_of_stock_7d: count("out_of_stock_7d"), fluctuating_30d: count("fluctuating_30d"),
  };
  const inStock = counts.in_stock ?? 0;
  return {
    summary: {
      as_of: asOf,
      total_rows: rows.length,
      in_stock_rows: inStock,
      online_rate: asOf !== null && rows.length ? inStock / rows.length : null,
      changed_rows: counts.changed,
      out_of_stock_7d_rows: counts.out_of_stock_7d,
      fluctuating_30d_rows: counts.fluctuating_30d,
    },
    matches: (sku, metric) => counts[metric] !== null && flags.get(sku)?.[metric] === true,
  };
}
