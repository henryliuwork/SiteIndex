import { useQuery } from "@tanstack/react-query";
import { PENDING_HANDLERS, type SiteIndexApi } from "@siteindex/shared";
import { api } from "../../../api";
import { ApiErrorNotice, EmptyState } from "../../../components";
import "./scenario-sections.css";

export type ProductScenarioTab = "changes" | "skuBrief" | "groupFamily";
const labels: Record<ProductScenarioTab, string> = { changes: "变更记录", skuBrief: "SKU 简报", groupFamily: "父子归并建议" };

export function productScenarioOptions(products: SiteIndexApi["products"], mock: boolean, sku: string | null,
  pending: readonly string[] = PENDING_HANDLERS) {
  if (!sku) return [];
  return (["changes", "skuBrief", "groupFamily"] as const).filter((method) =>
    typeof products[method] === "function" && (mock || !pending.includes(`products.${method}`)))
    .map((value) => ({ value, label: labels[value] }));
}

function QueryState({ loading, error, data, empty, onRetry, children }: {
  loading: boolean; error: unknown; data: unknown; empty: string; onRetry: () => void; children: React.ReactNode;
}) {
  if (loading) return <div className="si-query-loading" role="status">正在加载查询结果…</div>;
  if (error) return <ApiErrorNotice label="查询失败。" error={error} onRetry={onRetry} />;
  if (data == null) return <EmptyState>{empty}</EmptyState>;
  return <>{children}</>;
}

function valueLabel(value: unknown): string {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : "—";
}

export function ProductScenarioSection({ id, sku, tab }: { id: string; sku: string; tab: ProductScenarioTab }) {
  if (tab === "changes") return <Changes id={id} sku={sku} />;
  if (tab === "skuBrief") return <SkuBrief id={id} sku={sku} />;
  return <GroupFamily id={id} sku={sku} />;
}

function Changes({ id, sku }: { id: string; sku: string }) {
  const query = useQuery({ queryKey: ["products", "changes", id, sku], queryFn: () => api.products.changes!(id, sku) });
  const changes = query.data?.data;
  return <QueryState loading={query.isLoading} error={query.error} data={changes} empty="没有可用的变更记录。" onRetry={() => void query.refetch()}>
    {changes?.length ? <ul className="si-product-scenario-list">{changes.map((event, index) => <li key={`${event.date}:${event.type}:${index}`}>
      <strong>{event.date} · {event.type === "price_change" ? "价格变化" : event.type === "stock_change" ? "库存变化" : event.type === "new_sku" ? "新增 SKU" : event.type === "removed_sku" ? "SKU 下架" : event.type === "restored_sku" ? "SKU 恢复" : "Feed 异常"}</strong>
      <span>{valueLabel(event.from)} → {valueLabel(event.to)}</span>
    </li>)}</ul> : <EmptyState>此 SKU 暂无变更记录。</EmptyState>}
  </QueryState>;
}

function SkuBrief({ id, sku }: { id: string; sku: string }) {
  const query = useQuery({ queryKey: ["products", "skuBrief", id, sku], queryFn: () => api.products.skuBrief!(id, sku) });
  const brief = query.data?.data;
  return <QueryState loading={query.isLoading} error={query.error} data={brief} empty="没有这条 SKU 的简报。" onRetry={() => void query.refetch()}>
    {brief && <div className="si-product-scenario"><strong>{brief.sku.title}</strong><code>{brief.sku.sku}</code>
      <dl><div><dt>分类</dt><dd>{brief.sku.category || "—"}</dd></div><div><dt>Feed 状态</dt><dd>{brief.sku.status === "active" ? "在售" : "已下架"}</dd></div>
        <div><dt>最近价格</dt><dd>{brief.stock ? `${brief.stock.price.toFixed(2)} ${brief.sku.currency}` : "—"}</dd></div>
        <div><dt>库存状态</dt><dd>{brief.stock?.stock_status === "in_stock" ? "有货" : brief.stock?.stock_status === "out_of_stock" ? "缺货" : brief.stock?.stock_status === "preorder" ? "预售" : brief.stock?.stock_status === "unknown" ? "未知" : "—"}</dd></div></dl>
    </div>}
  </QueryState>;
}

function GroupFamily({ id, sku }: { id: string; sku: string }) {
  const query = useQuery({ queryKey: ["products", "groupFamily", id, sku], queryFn: () => api.products.groupFamily!(id, sku) });
  const family = query.data?.data;
  const role = { parent: "父 SKU", child: "子 SKU", single: "独立 SKU", collision: "归并冲突" } as const;
  return <QueryState loading={query.isLoading} error={query.error} data={family} empty="没有这条 SKU 的父子归并数据。" onRetry={() => void query.refetch()}>
    {family && <div className="si-product-scenario"><strong>{role[family.role]}</strong><code>{family.sku}</code>
      <p>父 SKU：{family.parent_sku ?? "—"}</p><p>关联子 SKU：{family.child_skus.length} 个</p>
      {family.child_skus.length > 0 && <ul className="si-product-scenario-list">{family.child_skus.map((child) => <li key={child}><code>{child}</code></li>)}</ul>}
      {family.collision && <><p>父 SKU {family.collision.parent} 本身也在 Feed 中，已跳过归并。</p>
        <ul className="si-product-scenario-list">{family.collision.children.map((child) => <li key={child}><code>{child}</code></li>)}</ul></>}
      <small>归并关系仅供查看；推导出的父 SKU 不代表库存实体。</small>
    </div>}
  </QueryState>;
}
