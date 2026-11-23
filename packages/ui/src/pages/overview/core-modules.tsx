import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { InventorySummary, ProjectTodosResult, SeoPageTableResult, SeoSummary } from "@siteindex/shared";
import { ApiErrorNotice, Notice } from "../../components";

type ModuleQuery<T> = { data: T | undefined; isPending: boolean; isError: boolean; error: unknown; refetch: () => unknown };

function Module({ title, to, children }: { title: string; to: string; children: ReactNode }) {
  return <section className="si-overview-module si-panel" aria-label={title}>
    <h2><Link to={to}>{title}</Link></h2>
    {children}
  </section>;
}

function Metric({ label, value, to, tone }: { label: string; value: string; to?: string; tone?: "danger" }) {
  const content = <><span>{label}</span><strong className={tone === "danger" ? "is-danger" : undefined}>{value}</strong></>;
  return to ? <Link className="si-overview-module-metric" to={to}>{content}</Link>
    : <div className="si-overview-module-metric">{content}</div>;
}

export function TodoModule({ id, available, query }: { id: string; available: boolean; query: ModuleQuery<ProjectTodosResult> }) {
  const to = `/p/${encodeURIComponent(id)}/todos`;
  const result = query.data;
  const trusted = result?.scan.status === "complete";
  const unfinished = trusted ? result.items.filter((item) => !["done", "ignored"].includes(item.state.status)) : [];
  const recent = [...unfinished].sort((left, right) => right.finding.last_seen_at.localeCompare(left.finding.last_seen_at)).slice(0, 3);
  return <Module title="待办" to={to}>
    {!available ? <Notice tone="warn">当前版本未提供项目待办数据。</Notice>
      : query.isPending ? <p role="status">正在加载待办…</p>
        : query.isError ? <ApiErrorNotice label="待办加载失败。" error={query.error} onRetry={() => void query.refetch()} />
          : !trusted ? <Notice tone="warn">规则检查尚未完整完成，暂不能确认未完成数。</Notice>
            : <>
              <div className="si-overview-module-metrics">
                <Metric label="未完成" value={String(unfinished.length)} to={`${to}?status=active`} tone={unfinished.length ? "danger" : undefined} />
                <Metric label="本周到期" value="—" />
              </div>
              <p className="si-overview-module-hint">待办尚无截止时间数据。</p>
              {recent.length ? <ul className="si-overview-module-list">{recent.map((item) => <li key={item.finding.dedupe_key}>
                <Link to={`${to}?status=active&todo=${encodeURIComponent(item.finding.dedupe_key)}`} title={item.finding.title}>{item.finding.title}</Link>
              </li>)}</ul> : <p className="si-overview-module-empty">当前没有未完成待办。</p>}
            </>}
  </Module>;
}

export function ProductModule({ id, query }: { id: string; query: ModuleQuery<InventorySummary> }) {
  const to = `/p/${encodeURIComponent(id)}/products`;
  const summary = query.data?.product_management;
  const metrics = summary?.as_of ? [
    { key: "in_stock", label: "在线率", value: summary.online_rate == null ? "—" : `${Math.round(summary.online_rate * 100)}%` },
    { key: "changed", label: "今日变化", value: summary.changed_rows?.toString() ?? "—" },
    { key: "out_of_stock_7d", label: "长期缺货", value: summary.out_of_stock_7d_rows?.toString() ?? "—" },
    { key: "fluctuating_30d", label: "状态波动", value: summary.fluctuating_30d_rows?.toString() ?? "—" },
  ] : [];
  return <Module title="产品管理" to={to}>
    {query.isPending ? <p role="status">正在加载产品管理摘要…</p>
      : query.isError ? <ApiErrorNotice label="产品管理摘要加载失败。" error={query.error} onRetry={() => void query.refetch()} />
        : metrics.length ? <div className="si-overview-module-metrics">{metrics.map((metric) => <Metric key={metric.key} label={metric.label} value={metric.value}
          to={metric.value === "—" ? undefined : `${to}?summary_metric=${metric.key}`} tone={metric.key !== "in_stock" && metric.value !== "0" && metric.value !== "—" ? "danger" : undefined} />)}</div>
          : <p className="si-overview-module-empty">尚无产品管理业务日数据，请先同步商品。</p>}
  </Module>;
}

export function SeoModule({ id, summaryQuery, pagesQuery, hasPageRows }: {
  id: string; summaryQuery: ModuleQuery<SeoSummary>; pagesQuery: ModuleQuery<SeoPageTableResult>; hasPageRows: boolean;
}) {
  const to = `/p/${encodeURIComponent(id)}/seo`;
  const issueMetric = summaryQuery.data?.kpis.find((metric) => metric.key === "issues");
  const issues = summaryQuery.data?.crawled_at && issueMetric && /^\d+$/.test(issueMetric.value) ? issueMetric.value : "—";
  const pages = hasPageRows && pagesQuery.data?.summary.latest_crawl_date ? pagesQuery.data.summary : null;
  return <Module title="SEO" to={to}>
    {summaryQuery.isPending || (hasPageRows && pagesQuery.isPending) ? <p role="status">正在加载 SEO 摘要…</p>
      : summaryQuery.isError || pagesQuery.isError ? <ApiErrorNotice label="SEO 摘要加载失败。" error={summaryQuery.error ?? pagesQuery.error} onRetry={() => { void summaryQuery.refetch(); if (hasPageRows) void pagesQuery.refetch(); }} />
        : issues === "—" && !pages ? <p className="si-overview-module-empty">尚无 SEO 抓取数据，请先运行抓取。</p>
          : <div className="si-overview-module-metrics">
            <Metric label="待处理问题" value={issues} to={issues === "—" ? undefined : `${to}?status=open`} tone={issues !== "0" && issues !== "—" ? "danger" : undefined} />
            <Metric label="本次新增问题页" value={pages?.new_pages.toString() ?? "—"} to={pages ? `${to}?summary=new` : undefined} />
            <Metric label="未收录页面" value={pages?.unindexed_pages.toString() ?? "—"} to={pages ? `${to}?summary=unindexed` : undefined} />
          </div>}
    {!hasPageRows && !summaryQuery.isPending && !summaryQuery.isError && <p className="si-overview-module-hint">当前版本尚未提供 SEO 页面聚合。</p>}
  </Module>;
}
