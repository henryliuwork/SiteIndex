import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { Download, FileText, RefreshCw, Settings2, TrendingUp } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import {
  CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import type { HistoryRange, InventorySummary, Kpi, ListQuery, ProjectSummary, SkuGroupingRule, SkuStockFilters, SkuStockView, StockStatus, WatchedCategory } from "@siteindex/shared";
import { api, apiErrorMessage, isMockApi } from "../api";
import { projectQueryKeys } from "../project-queries";
import { ApiErrorNotice, Button, Chip, DataTable, Drawer, FilterBar, formatDateTime, KpiCard, Notice, PageHeader, ProjectHeader, ProjectTabPanel, SearchInput, Select, StatusCells, stockTone, useToast } from "../components";
import { selectInventoryCategoryRates } from "./inventory/categories";
import { InventoryHistoryCell, InventoryRateCell } from "./inventory/table-cells";
import { DEFAULT_TREND_CATEGORY_LIMIT, MAX_TREND_CATEGORY_LIMIT, defaultTrendCategories, toggleTrendCategory, trendPoints } from "./inventory/trend";
import { fetchSkuGroupingPreview, skuGroupingPreviewQueryKey } from "./project-settings-config/sku-grouping-preview";

const stockNames: Record<StockStatus, string> = {
  in_stock: "有货", out_of_stock: "缺货", preorder: "预售", unknown: "未知",
};
const stockOptions = [
  { value: "all", label: "全部" }, { value: "in_stock", label: "有货" },
  { value: "out_of_stock", label: "缺货" }, { value: "preorder", label: "预售" },
  { value: "unknown", label: "未知" }, { value: "today", label: "今日有变化" },
] as const;
const lineColors = ["var(--color-chart-feeders)", "var(--color-chart-baths)", "var(--color-chart-houses)", "var(--color-info)", "var(--color-stock-preorder)"];
const INITIAL_QUERY: ListQuery<SkuStockFilters> = { page: 1, pageSize: 50, filters: {} };
const historyRanges: { value: HistoryRange; label: string }[] = [
  { value: 30, label: "30 天" }, { value: 60, label: "60 天" }, { value: 90, label: "90 天" }, { value: "all", label: "全部" },
];
type InventoryTableRow = SkuStockView;

function rangeLabel(range: HistoryRange): string { return range === "all" ? "全部" : `近 ${range} 天`; }
function businessDateLabel(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }).format(new Date(value + "T00:00:00Z"));
}

function requestInventorySummary(id: string, range: HistoryRange): Promise<InventorySummary> {
  if (!isMockApi) {
    if (range !== 30) throw new Error("当前桌面接口仅支持 30 天范围，其他范围将在接口更新后开放。");
    return api.inventory.summary(id, 30);
  }
  const summary = api.inventory.summary as unknown as (projectId: string, historyRange: 14 | HistoryRange) => Promise<InventorySummary>;
  return summary(id, range);
}

function platformName(project: ProjectSummary | undefined): string {
  const names: Record<ProjectSummary["platform"], string> = {
    magento: "Magento", wordpress: "WordPress", woocommerce: "WooCommerce", shopify: "Shopify", other: "其他平台",
  };
  return project ? names[project.platform] : "";
}

function formatRate(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : (value * 100).toFixed(0) + "%";
}

function dateTime(value: string | null): string {
  if (!value) return "尚未同步";
  return formatDateTime(value);
}

function categorySourceLabel(summary: InventorySummary, project: ProjectSummary | undefined): string {
  if (summary.category_source === "manual") return "手动配置" + (project ? "（" + platformName(project) + "）" : "");
  if (summary.category_source === "feed") return "Feed 分类字段";
  return "URL 规则";
}

const TrendChart = memo(function TrendChart({ summary, range, onRangeChange, selectedCategories, onSelectedCategoriesChange }: {
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
  return (
    <section className="si-inventory-chart si-panel" aria-label="分类在线率趋势">
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
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={points} margin={{ top: 10, right: 12, bottom: 4, left: 0 }}>
            <CartesianGrid stroke="var(--color-line-soft)" vertical={false} />
            <XAxis dataKey="day" tick={{ fill: "var(--color-muted)", fontSize: "var(--fs-caption)" }} tickLine={false} axisLine={false} interval={Math.max(0, Math.floor(points.length / 5) - 1)} />
            <YAxis domain={[0, 1]} ticks={[0, 0.25, 0.5, 0.75, 1]} tickFormatter={(value: number) => Math.round(value * 100) + "%"} tick={{ fill: "var(--color-muted)", fontSize: "var(--fs-caption)" }} tickLine={false} axisLine={false} width={40} />
            <Tooltip formatter={(value) => [formatRate(typeof value === "number" ? value : null), "在线率"]} labelFormatter={(label) => "日期 " + label} />
            {visibleSeries.map((series, index) => (
              <Line key={series.category} type="monotone" dataKey={series.category} name={series.category} stroke={lineColors[index % lineColors.length]} strokeWidth={2.4} dot={hasOneDate ? { r: 3 } : false} activeDot={{ r: 3 }} connectNulls={false} isAnimationActive={false} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>}
      <section className="si-inventory-trend-legend" aria-label="趋势图例">
        <div className="si-inventory-trend-legend-heading"><strong>图例 · {visibleSeries.length} 个分类</strong><button type="button" aria-controls="si-inventory-trend-legend-list" aria-expanded={legendExpanded} onClick={() => setLegendExpanded((expanded) => !expanded)}>{legendExpanded ? "收起" : "展开"}</button></div>
        <div id="si-inventory-trend-legend-list" hidden={!legendExpanded}>
          {visibleSeries.length > 0 ? <ul>{visibleSeries.map((series, index) => <li key={series.category}><i style={{ backgroundColor: lineColors[index % lineColors.length] }} aria-hidden="true" /><span>{series.category}</span></li>)}</ul> : <p>未选择分类。</p>}
        </div>
      </section>
    </section>
  );
});

const CategoryPanel = memo(function CategoryPanel({ summary, project, watchedCategories, showDefaultCategories, onShowDefaultCategories, expanded, onToggleExpanded, onManage, onSelectCategory }: {
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
  const categories = selectInventoryCategoryRates(summary, watchedCategories, showDefaultCategories);
  const rows = expanded ? categories : categories.slice(0, 8);
  return (
    <aside className="si-category-panel si-panel">
      <div className="si-panel-heading">
        <h2>分类在线率</h2>
        <Button size="small" onClick={onManage}>设置关注分类</Button>
      </div>
      <label className="si-category-default-toggle"><input type="checkbox" checked={showDefaultCategories} onChange={(event) => onShowDefaultCategories(event.target.checked)} /><span>展示默认分类</span></label>
      <p className="si-category-source">分类来源：{categorySourceLabel(summary, project)} · 未归类 {summary.uncategorized.toLocaleString("zh-CN")}</p>
      <div className="si-category-rates">
        {rows.map((item) => (
          <button type="button" className="si-category-rate" key={item.category} onClick={() => onSelectCategory(item.category)}>
            <span className="si-category-name">{item.label}{item.watched && <small>关注</small>}{item.manual && <small className="si-category-manual">手动</small>}</span>
            {item.total > 0 ? <span className="si-category-track" role="progressbar" aria-label={item.category + "在线率"} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(item.rate * 100)}>
              <span className={item.rate < 0.6 ? "is-low" : ""} style={{ width: Math.max(0, Math.min(100, item.rate * 100)) + "%" }} />
            </span> : <span className="si-category-no-data">暂无库存数据</span>}
            <span className="si-category-percent">{item.total ? formatRate(item.rate) : "—"}</span>
          </button>
        ))}
        {categories.length === 0 && <p className="si-empty-note">暂无分类数据。可设置关注分类。</p>}
        {categories.length > 0 && categories.every((item) => item.total === 0) && <p className="si-empty-note">这些分类暂时没有库存数据；完成一次同步后会显示库存指标。</p>}
      </div>
      {categories.length > 8 && <Button variant="ghost" size="small" className="si-category-expand" onClick={onToggleExpanded}>{expanded ? "收起分类" : "展开全部 " + categories.length + " 个分类"}</Button>}
      <div className="si-today-changes">
        <h3>今日变化</h3>
        {summary.today.length > 0 ? summary.today.slice(0, 4).map((item, index) => {
          const label = item.type === "restock" ? "到货" : item.type === "oos" ? "缺货" : item.type === "price" ? "调价" : item.type === "new" ? "上新" : "移除";
          const tone = item.type === "oos" || item.type === "removed" ? "danger" : item.type === "restock" ? "ok" : item.type === "new" ? "info" : "warn";
          return <div className="si-today-change" key={item.sku + "-" + index}><Chip tone={tone}>{label}</Chip><span><strong>{item.sku}</strong> {item.title}</span></div>;
        }) : <p className="si-empty-note">今天没有库存变化。</p>}
      </div>
    </aside>
  );
});

function GroupingPreview({ projectId, rule, enabled }: { projectId: string; rule: SkuGroupingRule; enabled: boolean }) {
  const previewQuery = useQuery({
    queryKey: skuGroupingPreviewQueryKey(projectId, rule),
    queryFn: () => fetchSkuGroupingPreview(api, projectId, rule),
    enabled,
    staleTime: 60_000,
  });
  const preview = previewQuery.data;
  return <div className="si-inventory-grouping-preview">
    <div className="si-inventory-grouping-rule"><span>当前规则</span><code>{rule.type} · {rule.value}</code></div>
    {previewQuery.isLoading ? <p role="status">正在通过 Core 计算 SKU 分组预览…</p>
      : previewQuery.isError ? <ApiErrorNotice label="SKU 分组预览加载失败。" error={previewQuery.error} onRetry={() => void previewQuery.refetch()} />
        : preview ? <>
          <div className="si-inventory-grouping-stats"><span><strong>{preview.parents}</strong> 个父 SKU</span><span>已匹配 <strong>{preview.children}</strong> 个子 SKU</span><span>未匹配 <strong>{preview.unmatched}</strong> 个</span></div>
          {preview.samples.length > 0 ? <ul>{preview.samples.slice(0, 6).map((sample) => <li key={sample.parent}><code>{sample.parent}</code><span>{sample.children.length} 个：{sample.children.slice(0, 4).join("、")}{sample.children.length > 4 ? " …" : ""}</span></li>)}</ul> : <p>当前规则没有可展示的分组样例。</p>}
          {preview.collisions?.length ? <details><summary>有 {preview.collisions.length} 组父 SKU 本身也在售，已跳过分组</summary><ul>{preview.collisions.map((collision) => <li key={collision.parent}><code>{collision.parent}</code><span>子 SKU：{collision.children.length ? collision.children.join("、") : "未提供明细"}</span></li>)}</ul></details> : null}
          <small>这是 Core 的规则预览，不代表父 SKU 的库存或在线率。</small>
        </> : <p role="status">正在准备 SKU 分组预览…</p>}
  </div>;
}

function StockDetail({ row }: { row: InventoryTableRow }) {
  const [range, setRange] = useState<HistoryRange>(30);
  const pricePoints = row.price_history ?? [];
  const latestPriceDate = pricePoints.at(-1)?.date;
  const cutoff = range === "all" || !latestPriceDate ? null : Date.parse(latestPriceDate) - range * 86_400_000;
  const visiblePrices = pricePoints.filter((point) => cutoff === null || Date.parse(point.date) >= cutoff).map((point) => ({ date: point.date.slice(5), price: point.price }));
  return (
    <div className="si-stock-detail">
      <div className="si-stock-detail-title">{row.is_parent ? <Chip tone="info">父 SKU</Chip> : <Chip tone={stockTone[row.stock_status]}>{stockNames[row.stock_status]}</Chip>}<span>{row.category}</span></div>
      <dl className="si-detail-list">
        <div><dt>SKU</dt><dd className="si-mono">{row.sku}</dd></div>
        <div><dt>产品</dt><dd>{row.title}</dd></div>
        {row.is_parent && <div><dt>子 SKU</dt><dd>{row.children_count ?? 0} 个 · 有货 {row.in_stock_children_count ?? 0} 个</dd></div>}
        <div><dt>变体</dt><dd>{row.variant_title ?? "—"}</dd></div>
        <div><dt>价格</dt><dd className="si-mono">{row.price.toFixed(2)}</dd></div>
        <div><dt>当前状态持续</dt><dd>{row.days_in_status} 天</dd></div>
        {!row.is_parent && <div><dt>7 天在线率</dt><dd>{formatRate(row.online_rate_7d)}</dd></div>}
        {!row.is_parent && <div><dt>30 天在线率</dt><dd>{formatRate(row.online_rate_30d)}</dd></div>}
        <div><dt>30 天状态变化</dt><dd>{row.changes_30d} 次</dd></div>
        <div><dt>最近变化</dt><dd>{row.last_change ?? "无变化"}</dd></div>
        <div><dt>最近变化日期</dt><dd>{row.last_change_at ?? "—"}</dd></div>
      </dl>
      {!row.is_parent && <>
        <section className="si-stock-price-chart">
          <div className="si-stock-chart-heading"><h3>价格趋势</h3><Select ariaLabel="价格趋势范围" value={String(range)} onValueChange={(value) => setRange(value === "all" ? "all" : Number(value) as 30 | 60 | 90)} options={historyRanges.map((item) => ({ value: String(item.value), label: item.label }))} /></div>
          {visiblePrices.length > 0 ? <div className="si-stock-price-plot"><ResponsiveContainer width="100%" height="100%"><LineChart data={visiblePrices} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}><CartesianGrid stroke="var(--color-line-soft)" vertical={false} /><XAxis dataKey="date" tick={{ fill: "var(--color-muted)", fontSize: "var(--fs-caption)" }} tickLine={false} axisLine={false} /><YAxis width={48} tick={{ fill: "var(--color-muted)", fontSize: "var(--fs-caption)" }} tickLine={false} axisLine={false} /><Tooltip formatter={(value) => [typeof value === "number" ? value.toFixed(2) : "—", "价格"]} /><Line type="monotone" dataKey="price" name="价格" stroke="var(--color-chart-feeders)" strokeWidth={2} dot={visiblePrices.length === 1 ? { r: 3 } : false} activeDot={{ r: 3 }} isAnimationActive={false} /></LineChart></ResponsiveContainer></div> : <p className="si-muted">暂无价格历史。</p>}
        </section>
        <section className="si-stock-detail-history"><h3>近 30 天库存状态</h3><StatusCells history={row.history_30d} /></section>
      </>}
    </div>
  );
}

function inventoryColumns(): ColumnDef<InventoryTableRow, unknown>[] {
  return [
    { id: "sku", accessorKey: "sku", header: "SKU", meta: { width: 122, grow: 0, minWidth: 110, text: "single" }, cell: ({ row }) => <span className="si-inventory-sku-cell"><span className="si-mono">{row.original.sku}</span>{row.original.is_parent && <small>父 SKU</small>}</span>, enableSorting: true },
    { id: "title", accessorKey: "title", header: "产品 / 变体", meta: { width: 300, grow: 2, minWidth: 220, text: "single" }, cell: ({ row }) => <span className="si-product-cell"><strong>{row.original.title}</strong>{row.original.is_parent && <small>子 SKU {row.original.children_count ?? 0} 个 · 有货 {row.original.in_stock_children_count ?? 0} 个</small>}{!row.original.is_parent && row.original.variant_title && <small>{row.original.variant_title}</small>}</span>, enableSorting: true },
    { id: "category", accessorKey: "category", header: "分类", meta: { width: 150, grow: 1, minWidth: 120, text: "single" }, cell: ({ row }) => <span className="si-mono">{row.original.category}</span>, enableSorting: true },
    { id: "price", accessorKey: "price", header: "价格", meta: { width: 96, grow: 0, minWidth: 88, align: "end", text: "single" }, cell: ({ row }) => <span className="si-mono">{row.original.price.toFixed(2)}</span>, enableSorting: true },
    { id: "stock_status", accessorKey: "stock_status", header: "当前状态", meta: { width: 104, grow: 0, minWidth: 94, text: "single" }, cell: ({ row }) => <Chip tone={stockTone[row.original.stock_status]}>{stockNames[row.original.stock_status]}</Chip>, enableSorting: true },
    { id: "days_in_status", accessorKey: "days_in_status", header: "持续", meta: { width: 84, grow: 0, minWidth: 76, align: "end", text: "single" }, cell: ({ row }) => row.original.days_in_status >= 60 ? "60 天+" : row.original.days_in_status <= 1 ? "今天" : row.original.days_in_status + " 天", enableSorting: true },
    { id: "online_rate_30d", accessorKey: "online_rate_30d", header: "30 天在线率", meta: { width: 140, grow: 0, minWidth: 128, align: "end", text: "single" }, cell: ({ row }) => <InventoryRateCell value={row.original.online_rate_30d} />, enableSorting: true },
    { id: "history_30d", accessorKey: "history_30d", header: "近 30 天（左旧右新）", meta: { width: 184, grow: 0, minWidth: 168, text: "single" }, cell: ({ row }) => <InventoryHistoryCell row={row.original} />, enableSorting: false },
    { id: "last_change", accessorKey: "last_change", header: "最近变化", meta: { width: 180, grow: 1, minWidth: 150, text: "clamp2" }, cell: ({ row }) => row.original.last_change ? <span className="si-last-change"><strong>{row.original.last_change_at ?? "近期"}</strong><small>{row.original.last_change}</small></span> : <span className="si-muted">—</span>, enableSorting: true },
  ];
}

export function InventoryPage() {
  const { id = "demo" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [query, setQuery] = useState<ListQuery<SkuStockFilters>>(INITIAL_QUERY);
  const [selectedRow, setSelectedRow] = useState<InventoryTableRow | null>(null);
  const [historyRange, setHistoryRange] = useState<HistoryRange>(30);
  const [trendSelection, setTrendSelection] = useState<{ projectId: string; categories: string[] } | null>(null);
  const [showDefaultCategories, setShowDefaultCategories] = useState<boolean | null>(null);
  const [categoriesExpanded, setCategoriesExpanded] = useState(false);
  const [trendDrawerOpen, setTrendDrawerOpen] = useState(false);
  const [groupingDrawerOpen, setGroupingDrawerOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [report, setReport] = useState<string | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportError, setReportError] = useState<unknown>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [syncMessage, setSyncMessage] = useState("");

  useEffect(() => {
    setQuery(INITIAL_QUERY); setSelectedRow(null); setShowDefaultCategories(null); setCategoriesExpanded(false); setHistoryRange(30);
    setTrendSelection(null); setTrendDrawerOpen(false); setGroupingDrawerOpen(false); setReportOpen(false);
  }, [id]);
  useEffect(() => {
    if (!activeRunId) return;
    const unsubscribeProgress = api.jobs.onProgress((progress) => {
      if (progress.runId === activeRunId) setSyncMessage(progress.message);
    });
    const unsubscribeFinished = api.jobs.onFinished((result) => {
      if (result.runId !== activeRunId) return;
      setSyncMessage("");
      setActiveRunId(null);
      void queryClient.invalidateQueries({ queryKey: ["inventory-summary", id] });
      void queryClient.invalidateQueries({ queryKey: ["inventory-skus", id] });
      if (result.status === "ok") toast.success("库存同步已完成。");
      else toast.error(result.summary || "库存同步失败。");
    });
    return () => { unsubscribeProgress(); unsubscribeFinished(); };
  }, [activeRunId, id, queryClient, toast]);

  const projectQuery = useQuery({ queryKey: projectQueryKeys.detail(id), queryFn: () => api.projects.get(id) });
  const summaryQuery = useQuery({ queryKey: ["inventory-summary", id, historyRange], queryFn: () => requestInventorySummary(id, historyRange) });
  const skuQuery = useQuery({ queryKey: ["inventory-skus", id, query], queryFn: () => api.inventory.listSkus(id, query), placeholderData: (previous) => previous });
  const columns = useMemo(inventoryColumns, []);
  const summary = summaryQuery.data;
  const project = projectQuery.data?.summary;
  const watchedCategories = projectQuery.data?.config.categories.watched ?? [];
  const groupingConfig = projectQuery.data?.config.sku_grouping;
  const groupingEnabled = groupingConfig?.enabled === true;
  const groupingRule: SkuGroupingRule = groupingConfig?.rule ?? { type: "separator", value: "-" };
  const selectedTrendCategories = trendSelection?.projectId === id ? trendSelection.categories : null;
  const displayDefaultCategories = showDefaultCategories ?? watchedCategories.length === 0;
  const skuRows = (skuQuery.data?.rows ?? []) as InventoryTableRow[];
  const kpis: Kpi[] = summary?.kpis ?? [];
  const statusFilter = query.filters?.status ?? "all";
  const categoryFilter = query.filters?.category ?? "all";
  const watchedOnly = Boolean(query.filters?.watched_only);
  const onSearch = useCallback((search: string) => setQuery((current) => ({ ...current, page: 1, search: search || undefined })), []);
  const onStatusChange = (value: string | undefined) => setQuery((current) => ({ ...current, page: 1, filters: { ...current.filters, status: !value || value === "all" ? undefined : value as SkuStockFilters["status"] } }));
  const onCategoryChange = (value: string | undefined) => setQuery((current) => ({ ...current, page: 1, filters: { ...current.filters, category: !value || value === "all" ? undefined : value } }));
  const onWatchedOnlyChange = (checked: boolean) => setQuery((current) => ({ ...current, page: 1, filters: { ...current.filters, watched_only: checked || undefined } }));
  const onPriceChange = (value: string | undefined) => setQuery((current) => ({ ...current, page: 1, filters: { ...current.filters, price_changed_within: !value || value === "none" ? undefined : value === "all" ? "all" : Number(value) as 30 | 60 | 90 } }));
  const onParentOnlyChange = (checked: boolean) => {
    if (!groupingEnabled) {
      if (checked) setGroupingDrawerOpen(true);
      return;
    }
    setQuery((current) => ({ ...current, page: 1, filters: { ...current.filters, parent_only: checked || undefined } }));
  };
  const sortByRate = () => setQuery((current) => ({ ...current, page: 1, sort: { field: "online_rate_30d", dir: current.sort?.field === "online_rate_30d" && current.sort.dir === "asc" ? "desc" : "asc" } }));

  const exportCsv = async () => {
    try {
      const path = await api.inventory.exportCsv(id, query);
      await api.shell.openPath(path);
      toast.success("CSV 已导出。");
    } catch (cause) { toast.error(apiErrorMessage(cause, "导出失败。")); }
  };
  const loadReport = async () => {
    setReportLoading(true);
    setReportError(null);
    try { setReport(await api.inventory.dailyReport(id, summary?.as_of ?? new Date().toISOString().slice(0, 10))); }
    catch (cause) { setReportError(cause); }
    finally { setReportLoading(false); }
  };
  const openReport = async () => {
    setReportOpen(true);
    await loadReport();
  };
  const runSync = async () => {
    if (!project) return;
    try {
      setSyncMessage("正在启动库存同步…");
      const run = await api.jobs.run({ projectPath: project.path, job: "daily" });
      setActiveRunId(run.runId);
    } catch (cause) { setSyncMessage(""); toast.error(apiErrorMessage(cause, "同步任务启动失败。")); }
  };
  const openGroupingSettings = () => {
    setGroupingDrawerOpen(false);
    navigate("/p/" + id + "/settings/config?section=sku-grouping");
  };
  const openCategorySettings = () => {
    setTrendDrawerOpen(false);
    navigate("/p/" + id + "/settings/config?section=watched-categories");
  };

  const tableToolbar = (
    <div className="si-inventory-toolbar">
      <div className="si-inventory-toolbar-top">
        <h2>SKU 库存明细</h2>
        <SearchInput value={query.search ?? ""} onSearch={onSearch} label="搜索 SKU 库存" placeholder="搜索 SKU、标题、变体" />
        <Button size="small" onClick={sortByRate}>按在线率排序</Button>
        <span className="si-table-total">显示 {skuRows.length} / {skuQuery.data?.total.toLocaleString("zh-CN") ?? "—"} 个{query.filters?.parent_only && groupingEnabled ? "父 SKU" : " SKU"}</span>
      </div>
      <FilterBar className="si-inventory-filters">
        <Select
          ariaLabel="库存状态筛选"
          className="si-inventory-filter-select"
          value={statusFilter}
          onValueChange={onStatusChange}
          options={stockOptions}
        />
        <Select
          ariaLabel="库存分类筛选"
          className="si-inventory-filter-select si-inventory-filter-category"
          value={categoryFilter}
          onValueChange={onCategoryChange}
          options={[{ value: "all", label: "全部分类" }, ...(summary?.category_rates ?? []).map((category) => ({ value: category.category, label: category.category }))]}
        />
        <Select
          ariaLabel="价格变动筛选"
          className="si-inventory-filter-select"
          value={query.filters?.price_changed_within?.toString() ?? "none"}
          onValueChange={onPriceChange}
          options={[
          { value: "none", label: "全部价格" }, { value: "30", label: "近 30 天" },
          { value: "60", label: "近 60 天" }, { value: "90", label: "近 90 天" }, { value: "all", label: "有历史变动" },
          ]}
        />
        <label className="si-inventory-parent-toggle si-inventory-watched-toggle"><input type="checkbox" aria-label="仅关注分类" checked={watchedOnly} onChange={(event) => onWatchedOnlyChange(event.target.checked)} /><span>仅关注分类</span></label>
        <label className="si-inventory-parent-toggle"><input type="checkbox" aria-label="仅展示父 SKU" checked={Boolean(query.filters?.parent_only && groupingEnabled)} onChange={(event) => onParentOnlyChange(event.target.checked)} /><span>仅展示父 SKU</span></label>
      </FilterBar>
    </div>
  );

  if (projectQuery.isLoading) return <div className="si-page-loading" role="status">正在加载项目信息…</div>;
  if (projectQuery.isError || !project) return <ApiErrorNotice page label="项目库存页面加载失败。" error={projectQuery.error} onRetry={() => void projectQuery.refetch()} />;

  return (
    <div className="si-page si-inventory-page">
      <ProjectHeader
        project={project}
        activeTab="inventory"
        hasTabPanel
        status={project.sync.state === "ok" ? <Chip tone="ok">{project.sync.at ? `${dateTime(project.sync.at)} · 同步成功` : "同步成功 · 时间未知"}</Chip> : <Chip tone={project.sync.state === "failed" ? "danger" : "warn"}>{project.sync.state === "failed" ? "同步失败" : project.sync.state === "running" ? "同步中" : "待处理"}</Chip>}
      />
      <ProjectTabPanel projectId={project.id} tab="inventory">
      <PageHeader
        title="库存"
        meta={<Chip tone="neutral">{summary?.as_of ? "数据日期：" + summary.as_of : "库存数据"}</Chip>}
        actions={<>
          <Button variant="primary" icon={<TrendingUp size={14} />} onClick={() => setTrendDrawerOpen(true)}>趋势与分类在线率</Button>
          <Button icon={<Download size={14} />} onClick={() => void exportCsv()}>导出 CSV</Button>
          <Button icon={<RefreshCw size={14} />} disabled={Boolean(activeRunId)} onClick={() => void runSync()}>{activeRunId ? "同步中…" : "立即同步"}</Button>
        </>}
        overflow={[
          { label: "SKU 父子规则设置", onSelect: openGroupingSettings, icon: <Settings2 size={14} /> },
          { label: "查看今日日报", onSelect: () => void openReport(), icon: <FileText size={14} /> },
        ]}
      />
      {syncMessage && <Notice tone="info" title="库存同步进行中">{syncMessage}</Notice>}
      {skuQuery.isFetching && skuQuery.data && <div className="si-inventory-query-state" role="status">正在更新 SKU 列表…</div>}
      {skuQuery.isError && <ApiErrorNotice className="si-inventory-query-state" label={"SKU 列表更新失败" + (skuQuery.data ? "，当前保留上次结果。" : "。")} error={skuQuery.error} onRetry={() => void skuQuery.refetch()} />}
      <div className="si-inventory-kpis">{summaryQuery.isLoading ? <div className="si-query-loading" role="status">正在加载库存概览…</div> : summaryQuery.isError || !summary ? <ApiErrorNotice label="库存概览加载失败。" error={summaryQuery.error} onRetry={() => void summaryQuery.refetch()} /> : kpis.slice(0, 5).map((metric) => <KpiCard key={metric.key} metric={metric} />)}</div>
      <DataTable
        tableId="inventory.skus"
        scopeId={id}
        rows={skuRows}
        total={skuQuery.data?.total ?? 0}
        columns={columns}
        query={query}
        onQueryChange={setQuery}
        onRowClick={setSelectedRow}
        getRowId={(row) => row.sku}
        height="fill"
        rowHeight={52}
        emptyTitle="没有匹配的 SKU"
        emptyDescription={watchedOnly ? "关注分类中没有符合当前筛选条件的 SKU。" : "请修改搜索文字或库存筛选条件。"}
        toolbar={tableToolbar}
      />
      <div className="si-inventory-legend" aria-label="库存状态图例">
        <span><i className="si-status-in" />有货</span><span><i className="si-status-out" />缺货</span><span><i className="si-status-preorder" />预售</span><span><i className="si-status-unknown" />未知 / 未上架</span>
        <span>数据：index/views/sku_stock.jsonl</span>
      </div>
      </ProjectTabPanel>
      <Drawer open={Boolean(selectedRow)} onOpenChange={(open) => { if (!open) setSelectedRow(null); }} title={selectedRow?.sku ?? "SKU 详情"}>
        {selectedRow && <StockDetail row={selectedRow} />}
      </Drawer>
      <Drawer open={trendDrawerOpen} onOpenChange={setTrendDrawerOpen} title="库存趋势与分类在线率" description="趋势仅使用 Core 返回的真实业务日期。单个日期显示单点，不补造历史。" width="wide">
        {summaryQuery.isLoading ? <div className="si-query-loading" role="status">正在加载库存概览…</div> : summaryQuery.isError || !summary ? <ApiErrorNotice label="库存概览加载失败。" error={summaryQuery.error} onRetry={() => void summaryQuery.refetch()} /> : <div className="si-inventory-overview-grid">
          <TrendChart summary={summary} range={historyRange} onRangeChange={setHistoryRange} selectedCategories={selectedTrendCategories} onSelectedCategoriesChange={(categories) => setTrendSelection({ projectId: id, categories })} />
          <CategoryPanel
            summary={summary}
            project={project}
            watchedCategories={watchedCategories}
            showDefaultCategories={displayDefaultCategories}
            onShowDefaultCategories={setShowDefaultCategories}
            expanded={categoriesExpanded}
            onToggleExpanded={() => setCategoriesExpanded((value) => !value)}
            onManage={openCategorySettings}
            onSelectCategory={onCategoryChange}
          />
        </div>}
      </Drawer>
      <Drawer open={groupingDrawerOpen} onOpenChange={setGroupingDrawerOpen} title="配置父子 SKU 规则" description="仅当项目启用分组后，库存列表才会筛选父 SKU。预览由 Core 计算。" footer={<div className="si-inventory-drawer-actions"><Button onClick={() => setGroupingDrawerOpen(false)}>关闭</Button><Button variant="primary" onClick={openGroupingSettings}>前往项目设置</Button></div>}>
        <Notice tone="warn" title="当前未启用父子 SKU 分组">“仅展示父 SKU”暂时不会改变库存列表。先在项目设置中启用规则，再返回这里筛选。</Notice>
        <GroupingPreview projectId={id} rule={groupingRule} enabled={groupingDrawerOpen} />
      </Drawer>
      <Drawer open={reportOpen} onOpenChange={setReportOpen} title="今日日报" description="库存变化与需要关注的 SKU。">
        {reportLoading ? <div className="si-query-loading" role="status">正在读取今日日报…</div> : reportError ? <ApiErrorNotice label="今日日报读取失败。" error={reportError} onRetry={() => void loadReport()} /> : <pre className="si-inventory-report">{report || "暂无今日日报。"}</pre>}
      </Drawer>
    </div>
  );
}
import "./inventory/page.css";
