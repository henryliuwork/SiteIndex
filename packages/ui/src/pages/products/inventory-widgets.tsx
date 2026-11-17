import { memo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { HistoryRange, InventorySummary, ProjectSummary, SkuGroupingRule, StockStatus, WatchedCategory } from "@siteindex/shared";
import { api, isMockApi } from "../../api";
import { ApiErrorNotice, Button, Chip, Select, stockTone } from "../../components";
import { selectInventoryCategoryRates } from "../inventory/categories";
import { DEFAULT_TREND_CATEGORY_LIMIT, MAX_TREND_CATEGORY_LIMIT, defaultTrendCategories, toggleTrendCategory, trendPoints } from "../inventory/trend";
import { fetchSkuGroupingPreview, skuGroupingPreviewQueryKey } from "../project-settings-config/sku-grouping-preview";

const stockNames: Record<StockStatus, string> = { in_stock: "有货", out_of_stock: "缺货", preorder: "预售", unknown: "未知" };
const lineColors = ["var(--color-chart-feeders)", "var(--color-chart-baths)", "var(--color-chart-houses)", "var(--color-info)", "var(--color-stock-preorder)"];
const historyRanges: { value: HistoryRange; label: string }[] = [
  { value: 30, label: "30 天" }, { value: 60, label: "60 天" }, { value: 90, label: "90 天" }, { value: "all", label: "全部" },
];

function rangeLabel(range: HistoryRange): string { return range === "all" ? "全部" : `近 ${range} 天`; }
function formatRate(value: number | null | undefined): string { return value === null || value === undefined ? "—" : (value * 100).toFixed(0) + "%"; }
function businessDateLabel(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }).format(new Date(value + "T00:00:00Z"));
}
function platformName(project: ProjectSummary | undefined): string {
  const names: Record<ProjectSummary["platform"], string> = { magento: "Magento", wordpress: "WordPress", woocommerce: "WooCommerce", shopify: "Shopify", other: "其他平台" };
  return project ? names[project.platform] : "";
}
function categorySourceLabel(summary: InventorySummary, project: ProjectSummary | undefined): string {
  if (summary.category_source === "manual") return "手动配置" + (project ? "（" + platformName(project) + "）" : "");
  if (summary.category_source === "feed") return "Feed 分类字段";
  return "URL 规则";
}

export function requestInventorySummary(id: string, range: HistoryRange): Promise<InventorySummary> {
  if (!isMockApi) {
    if (range !== 30) throw new Error("当前桌面接口仅支持 30 天范围，其他范围将在接口更新后开放。");
    return api.inventory.summary(id, 30);
  }
  const summary = api.inventory.summary as unknown as (projectId: string, historyRange: 14 | HistoryRange) => Promise<InventorySummary>;
  return summary(id, range);
}

export const TrendChart = memo(function TrendChart({ summary, range, onRangeChange, selectedCategories, onSelectedCategoriesChange }: {
  summary: InventorySummary;
  range: HistoryRange;
  onRangeChange: (range: HistoryRange) => void;
  selectedCategories: string[] | null;
  onSelectedCategoriesChange: (categories: string[]) => void;
}) {
  const [searchTerm, setSearchTerm] = useState("");
  const [legendExpanded, setLegendExpanded] = useState(true);
  const defaults = defaultTrendCategories(summary);
  const selection = selectedCategories ?? defaults;
  const selected = new Set(selection);
  const visibleSeries = summary.trend.series.filter((series) => selected.has(series.category));
  const points = trendPoints(summary, visibleSeries.map((series) => series.category));
  const availableCategories = summary.trend.series.map((series) => series.category);
  const normalizedSearchTerm = searchTerm.trim().toLocaleLowerCase("zh-CN");
  const filteredCategories = availableCategories.filter((category) => category.toLocaleLowerCase("zh-CN").includes(normalizedSearchTerm));
  const hasNoDates = summary.trend.dates.length === 0;
  const hasOneDate = summary.trend.dates.length === 1;
  return <section className="si-inventory-chart si-panel" aria-label="分类在线率趋势">
    <div className="si-panel-heading si-inventory-chart-heading">
      <h2>分类在线率趋势 · {rangeLabel(range)}</h2>
      <div className="si-inventory-chart-controls">
        <Select ariaLabel="在线率趋势范围" value={String(range)} onValueChange={(value) => onRangeChange(value === "all" ? "all" : Number(value) as 30 | 60 | 90)} options={historyRanges.map((item) => ({ value: String(item.value), label: item.label + (!isMockApi && item.value !== 30 ? "（接口更新后开放）" : ""), disabled: !isMockApi && item.value !== 30 }))} />
        <details className="si-inventory-trend-picker">
          <summary>选择分类 <span>{visibleSeries.length} / {MAX_TREND_CATEGORY_LIMIT}</span></summary>
          <div className="si-inventory-trend-picker-content">
            <label className="si-inventory-trend-search"><span className="si-sr-only">搜索趋势分类</span><input type="search" value={searchTerm} onChange={(event) => setSearchTerm(event.target.value)} placeholder="搜索分类" aria-label="搜索趋势分类" /></label>
            {filteredCategories.length > 0 ? <div className="si-inventory-trend-options" role="group" aria-label="趋势图分类">
              {filteredCategories.map((category) => {
                const checked = selected.has(category);
                return <label key={category}><input type="checkbox" checked={checked} disabled={!checked && visibleSeries.length >= MAX_TREND_CATEGORY_LIMIT} onChange={() => onSelectedCategoriesChange(toggleTrendCategory(selection, category))} /><span>{category}</span></label>;
              })}
            </div> : <p className="si-inventory-trend-empty">没有匹配的分类。</p>}
            <div className="si-inventory-trend-actions"><Button size="small" disabled={visibleSeries.length === 0} onClick={() => onSelectedCategoriesChange([])}>清除</Button><Button size="small" disabled={visibleSeries.length === defaults.length && visibleSeries.every((series, index) => series.category === defaults[index])} onClick={() => onSelectedCategoriesChange(defaults)}>重置默认</Button><small>默认最多 {DEFAULT_TREND_CATEGORY_LIMIT} 类，最多选择 {MAX_TREND_CATEGORY_LIMIT} 类</small></div>
          </div>
        </details>
      </div>
    </div>
    <p className="si-trend-meta">{summary.trend.dates[0] ? `数据自 ${businessDateLabel(summary.trend.dates[0])} 起` : "暂无历史日期"} · 站点时区 {summary.timezone || "未配置"}</p>
    {hasOneDate && <p className="si-inventory-trend-date-note" role="status">目前仅有 1 个业务日期，后续每日同步自动形成趋势。</p>}
    {hasNoDates ? <p className="si-inventory-trend-empty" role="status">暂无历史数据。</p> : visibleSeries.length === 0 ? <p className="si-inventory-trend-empty" role="status">请选择至少一个有历史数据的分类。</p> : <div className="si-inventory-trend-plot">
      <ResponsiveContainer width="100%" height="100%"><LineChart data={points} margin={{ top: 10, right: 12, bottom: 4, left: 0 }}>
        <CartesianGrid stroke="var(--color-line-soft)" vertical={false} />
        <XAxis dataKey="day" tick={{ fill: "var(--color-muted)", fontSize: "var(--fs-caption)" }} tickLine={false} axisLine={false} interval={Math.max(0, Math.floor(points.length / 5) - 1)} />
        <YAxis domain={[0, 1]} ticks={[0, 0.25, 0.5, 0.75, 1]} tickFormatter={(value: number) => Math.round(value * 100) + "%"} tick={{ fill: "var(--color-muted)", fontSize: "var(--fs-caption)" }} tickLine={false} axisLine={false} width={40} />
        <Tooltip formatter={(value) => [formatRate(typeof value === "number" ? value : null), "在线率"]} labelFormatter={(label) => "日期 " + label} />
        {visibleSeries.map((series, index) => <Line key={series.category} type="monotone" dataKey={series.category} name={series.category} stroke={lineColors[index % lineColors.length]} strokeWidth={2.4} dot={hasOneDate ? { r: 3 } : false} activeDot={{ r: 3 }} connectNulls={false} isAnimationActive={false} />)}
      </LineChart></ResponsiveContainer>
    </div>}
    <section className="si-inventory-trend-legend" aria-label="趋势图例">
      <div className="si-inventory-trend-legend-heading"><strong>图例 · {visibleSeries.length} 个分类</strong><button type="button" aria-controls="si-inventory-trend-legend-list" aria-expanded={legendExpanded} onClick={() => setLegendExpanded((expanded) => !expanded)}>{legendExpanded ? "收起" : "展开"}</button></div>
      <div id="si-inventory-trend-legend-list" hidden={!legendExpanded}>{visibleSeries.length > 0 ? <ul>{visibleSeries.map((series, index) => <li key={series.category}><i style={{ backgroundColor: lineColors[index % lineColors.length] }} aria-hidden="true" /><span>{series.category}</span></li>)}</ul> : <p>未选择分类。</p>}</div>
    </section>
  </section>;
});

export const CategoryPanel = memo(function CategoryPanel({ summary, project, watchedCategories, showDefaultCategories, onShowDefaultCategories, expanded, onToggleExpanded, onManage, onSelectCategory }: {
  summary: InventorySummary;
  project: ProjectSummary | undefined;
  watchedCategories: WatchedCategory[];
  showDefaultCategories: boolean;
  onShowDefaultCategories: (show: boolean) => void;
  expanded: boolean;
  onToggleExpanded: () => void;
  onManage: () => void;
  onSelectCategory: (slug: string) => void;
}) {
  const [anomaliesOnly, setAnomaliesOnly] = useState(false);
  const categories = selectInventoryCategoryRates(summary, watchedCategories, showDefaultCategories);
  const rows = expanded ? categories : categories.slice(0, 8);
  const hasFeedAnomalies = summary.today.some((item) => item.type === "feed_anomaly");
  const todayEvents = summary.today.filter((item) => !anomaliesOnly || item.type === "feed_anomaly");
  return <aside className="si-category-panel si-panel">
    <div className="si-panel-heading"><h2>分类在线率</h2><Button size="small" onClick={onManage}>设置关注分类</Button></div>
    <label className="si-category-default-toggle"><input type="checkbox" checked={showDefaultCategories} onChange={(event) => onShowDefaultCategories(event.target.checked)} /><span>展示默认分类</span></label>
    <p className="si-category-source">分类来源：{categorySourceLabel(summary, project)} · 未归类 {summary.uncategorized.toLocaleString("zh-CN")}</p>
    <div className="si-category-rates">
      {rows.map((item) => <button type="button" className="si-category-rate" key={item.category} onClick={() => onSelectCategory(item.category)}>
        <span className="si-category-name">{item.label}{item.watched && <small>关注</small>}{item.manual && <small className="si-category-manual">手动</small>}</span>
        {item.total > 0 ? <span className="si-category-track" role="progressbar" aria-label={item.category + "在线率"} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(item.rate * 100)}><span className={item.rate < 0.6 ? "is-low" : ""} style={{ width: Math.max(0, Math.min(100, item.rate * 100)) + "%" }} /></span> : <span className="si-category-no-data">暂无库存数据</span>}
        <span className="si-category-percent">{item.total ? formatRate(item.rate) : "—"}</span>
      </button>)}
      {categories.length === 0 && <p className="si-empty-note">暂无分类数据。可设置关注分类。</p>}
      {categories.length > 0 && categories.every((item) => item.total === 0) && <p className="si-empty-note">这些分类暂时没有库存数据；完成一次同步后会显示库存指标。</p>}
    </div>
    {categories.length > 8 && <Button variant="ghost" size="small" className="si-category-expand" onClick={onToggleExpanded}>{expanded ? "收起分类" : "展开全部 " + categories.length + " 个分类"}</Button>}
    <div className="si-today-changes">
      <div className="si-today-changes-heading"><h3>今日变化</h3>{isMockApi && <Chip tone="neutral">mock 示例</Chip>}</div>
      {hasFeedAnomalies && <label className="si-today-anomaly-filter"><input type="checkbox" checked={anomaliesOnly} onChange={(event) => setAnomaliesOnly(event.target.checked)} /><span>仅显示此摘要中的 Feed 异常</span></label>}
      {todayEvents.length > 0 ? todayEvents.slice(0, 4).map((item, index) => {
        const label = item.type === "feed_anomaly" ? "Feed 异常" : item.type === "restock" ? "到货" : item.type === "oos" ? "缺货" : item.type === "price" ? "调价" : item.type === "new" ? "上新" : "已下架";
        const tone = item.type === "feed_anomaly" || item.type === "oos" || item.type === "removed" ? "danger" : item.type === "restock" ? "ok" : item.type === "new" ? "info" : "warn";
        const description = [item.title, item.detail].filter(Boolean).join(" · ");
        return <div className="si-today-change" key={item.sku + "-" + index}><Chip tone={tone}>{label}</Chip><span title={item.sku + " " + description}><strong>{item.sku}</strong> {description}</span></div>;
      }) : <p className="si-empty-note">今天没有库存变化。</p>}
    </div>
  </aside>;
});

export function GroupingPreview({ projectId, rule, enabled }: { projectId: string; rule: SkuGroupingRule; enabled: boolean }) {
  const previewQuery = useQuery({ queryKey: skuGroupingPreviewQueryKey(projectId, rule), queryFn: () => fetchSkuGroupingPreview(api, projectId, rule), enabled, staleTime: 60_000 });
  const preview = previewQuery.data;
  return <div className="si-products-grouping-preview">
    <div className="si-products-grouping-rule"><span>当前规则</span><code>{rule.type} · {rule.value}</code></div>
    {previewQuery.isLoading ? <p role="status">正在通过 Core 计算 SKU 分组预览…</p>
      : previewQuery.isError ? <ApiErrorNotice label="SKU 分组预览加载失败。" error={previewQuery.error} onRetry={() => void previewQuery.refetch()} />
        : preview ? <>
          <div className="si-products-grouping-stats"><span><strong>{preview.parents}</strong> 个父 SKU</span><span>已匹配 <strong>{preview.children}</strong> 个子 SKU</span><span>未匹配 <strong>{preview.unmatched}</strong> 个</span></div>
          {preview.samples.length > 0 ? <ul>{preview.samples.slice(0, 6).map((sample) => <li key={sample.parent}><code>{sample.parent}</code><span>{sample.children.length} 个：{sample.children.slice(0, 4).join("、")}{sample.children.length > 4 ? " …" : ""}</span></li>)}</ul> : <p>当前规则没有可展示的分组样例。</p>}
          {preview.collisions?.length ? <details><summary>有 {preview.collisions.length} 组父 SKU 本身也在售，已跳过分组</summary><ul>{preview.collisions.map((collision) => <li key={collision.parent}><code>{collision.parent}</code><span>子 SKU：{collision.children.length ? collision.children.join("、") : "未提供明细"}</span></li>)}</ul></details> : null}
          <small>规则预览不代表父 SKU 的库存或在线率。</small>
        </> : <p role="status">正在准备 SKU 分组预览…</p>}
  </div>;
}

export { stockNames, historyRanges };
