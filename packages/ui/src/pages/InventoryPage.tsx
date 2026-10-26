import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import * as Dialog from "@radix-ui/react-dialog";
import { Download, FileText, RefreshCw } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import {
  CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import type { InventorySummary, Kpi, ListQuery, ProjectSummary, SkuStockFilters, SkuStockView, StockStatus } from "@siteindex/shared";
import { api, apiErrorMessage } from "../api";
import { Button, Chip, DataTable, DetailPanel, FilterPill, KpiCard, SearchInput, StatusCells, Tabs, stockTone } from "../components";

const stockNames: Record<StockStatus, string> = {
  in_stock: "有货", out_of_stock: "缺货", preorder: "预售", unknown: "未知",
};
const stockOptions = [
  { value: "all", label: "全部" }, { value: "in_stock", label: "有货" },
  { value: "out_of_stock", label: "缺货" }, { value: "preorder", label: "预售" },
  { value: "unknown", label: "未知" }, { value: "today", label: "今日有变化" },
] as const;
const lineColors = ["#1E6B52", "#E57920", "#78AEEB", "#8C68C5", "#4BA6A1"];
const tabOptions = [
  { value: "overview", label: "概览" }, { value: "inventory", label: "库存" },
  { value: "products", label: "产品" }, { value: "seo", label: "SEO" },
  { value: "content", label: "内容" }, { value: "edm", label: "EDM" },
  { value: "design", label: "设计" }, { value: "readme", label: "README" },
  { value: "runs", label: "运行" }, { value: "settings", label: "设置" },
] as const;
const INITIAL_QUERY: ListQuery<SkuStockFilters> = { page: 1, pageSize: 20, filters: {} };

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
  const date = new Date(value);
  return "今天 " + new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

function categorySourceLabel(summary: InventorySummary, project: ProjectSummary | undefined): string {
  if (summary.category_source === "manual") return "手动配置" + (project ? "（" + platformName(project) + "）" : "");
  if (summary.category_source === "feed") return "Feed 分类字段";
  return "URL 规则";
}

function trendPoints(summary: InventorySummary | undefined) {
  if (!summary) return [];
  return summary.trend.dates.map((date, index) => {
    const point: Record<string, string | number | null> = { day: date.slice(5) };
    for (const series of summary.trend.series) point[series.category] = series.rates[index] ?? null;
    return point;
  });
}

const TrendChart = memo(function TrendChart({ summary }: { summary: InventorySummary }) {
  const points = trendPoints(summary);
  return (
    <section className="si-inventory-chart si-panel" aria-label="分类在线率趋势">
      <div className="si-panel-heading">
        <h2>分类在线率趋势 · 近 30 天</h2>
        <Chip tone="neutral">示例数据</Chip>
      </div>
      <div className="si-trend-chart">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={points} margin={{ top: 10, right: 12, bottom: 4, left: 0 }}>
            <CartesianGrid stroke="#E8EBEF" vertical={false} />
            <XAxis dataKey="day" tick={{ fill: "#68737E", fontSize: 11 }} tickLine={false} axisLine={false} interval={Math.max(0, Math.floor(points.length / 5) - 1)} />
            <YAxis domain={[0, 1]} ticks={[0, 0.25, 0.5, 0.75, 1]} tickFormatter={(value: number) => Math.round(value * 100) + "%"} tick={{ fill: "#68737E", fontSize: 11 }} tickLine={false} axisLine={false} width={40} />
            <Tooltip formatter={(value) => [formatRate(typeof value === "number" ? value : null), "在线率"]} labelFormatter={(label) => "日期 " + label} />
            <Legend align="right" verticalAlign="top" height={34} iconType="plainline" wrapperStyle={{ fontSize: 11, color: "#47515B" }} />
            {summary.trend.series.map((series, index) => (
              <Line key={series.category} type="monotone" dataKey={series.category} name={series.category} stroke={lineColors[index % lineColors.length]} strokeWidth={2.4} dot={false} activeDot={{ r: 3 }} connectNulls={false} isAnimationActive={false} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
});

const CategoryPanel = memo(function CategoryPanel({ summary, project }: { summary: InventorySummary; project: ProjectSummary | undefined }) {
  return (
    <aside className="si-category-panel si-panel">
      <div className="si-panel-heading">
        <h2>分类在线率</h2>
        <a href={"#/p/" + project?.id + "/settings/categories"}>管理分类</a>
      </div>
      <p className="si-category-source">分类来源：{categorySourceLabel(summary, project)} · 未归类 {summary.uncategorized.toLocaleString("zh-CN")}</p>
      <div className="si-category-rates">
        {summary.category_rates.map((item) => (
          <div className="si-category-rate" key={item.category}>
            <span className="si-category-name">{item.category}</span>
            <span className="si-category-track" role="progressbar" aria-label={item.category + "在线率"} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(item.rate * 100)}>
              <span className={item.rate < 0.6 ? "is-low" : ""} style={{ width: Math.max(0, Math.min(100, item.rate * 100)) + "%" }} />
            </span>
            <span className="si-category-percent">{formatRate(item.rate)}</span>
          </div>
        ))}
        {summary.category_rates.length === 0 && <p className="si-empty-note">暂无分类数据</p>}
      </div>
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

function StockDetail({ row }: { row: SkuStockView }) {
  return (
    <div className="si-stock-detail">
      <div className="si-stock-detail-title"><Chip tone={stockTone[row.stock_status]}>{stockNames[row.stock_status]}</Chip><span>{row.category}</span></div>
      <dl className="si-detail-list">
        <div><dt>SKU</dt><dd className="si-mono">{row.sku}</dd></div>
        <div><dt>产品</dt><dd>{row.title}</dd></div>
        <div><dt>变体</dt><dd>{row.variant_title ?? "—"}</dd></div>
        <div><dt>价格</dt><dd className="si-mono">{row.price.toFixed(2)}</dd></div>
        <div><dt>当前状态持续</dt><dd>{row.days_in_status} 天</dd></div>
        <div><dt>7 天在线率</dt><dd>{formatRate(row.online_rate_7d)}</dd></div>
        <div><dt>30 天在线率</dt><dd>{formatRate(row.online_rate_30d)}</dd></div>
        <div><dt>30 天状态变化</dt><dd>{row.changes_30d} 次</dd></div>
        <div><dt>最近变化</dt><dd>{row.last_change ?? "无变化"}</dd></div>
        <div><dt>最近变化日期</dt><dd>{row.last_change_at ?? "—"}</dd></div>
      </dl>
      <section className="si-stock-detail-history"><h3>近 30 天库存状态</h3><StatusCells history={row.history_30d} /></section>
    </div>
  );
}

function DailyReportDialog({ report, onOpenChange }: { report: string | null | undefined; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog.Root open={report !== undefined} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="si-dialog-overlay" />
        <Dialog.Content className="si-confirm-dialog si-report-dialog">
          <Dialog.Title className="si-dialog-title">今日日报</Dialog.Title>
          <Dialog.Description className="si-dialog-description">库存变化与需要关注的 SKU。</Dialog.Description>
          <pre>{report || "暂无今日日报。"}</pre>
          <div className="si-dialog-actions"><Button onClick={() => onOpenChange(false)}>关闭</Button></div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function inventoryColumns(): ColumnDef<SkuStockView, unknown>[] {
  return [
    { id: "sku", accessorKey: "sku", header: "SKU", cell: ({ row }) => <span className="si-mono">{row.original.sku}</span>, enableSorting: true },
    { id: "title", accessorKey: "title", header: "产品 / 变体", cell: ({ row }) => <span className="si-product-cell"><strong>{row.original.title}</strong>{row.original.variant_title && <small>{row.original.variant_title}</small>}</span>, enableSorting: true },
    { id: "category", accessorKey: "category", header: "分类", cell: ({ row }) => <span className="si-mono">{row.original.category}</span>, enableSorting: true },
    { id: "price", accessorKey: "price", header: "价格", cell: ({ row }) => <span className="si-mono">{row.original.price.toFixed(2)}</span>, enableSorting: true },
    { id: "stock_status", accessorKey: "stock_status", header: "当前状态", cell: ({ row }) => <Chip tone={stockTone[row.original.stock_status]}>{stockNames[row.original.stock_status]}</Chip>, enableSorting: true },
    { id: "days_in_status", accessorKey: "days_in_status", header: "持续", cell: ({ row }) => row.original.days_in_status >= 60 ? "60 天+" : row.original.days_in_status <= 1 ? "今天" : row.original.days_in_status + " 天", enableSorting: true },
    { id: "online_rate_30d", accessorKey: "online_rate_30d", header: "30 天在线率", cell: ({ row }) => <span className="si-rate-cell"><span className="si-rate-track"><span className={row.original.online_rate_30d !== null && row.original.online_rate_30d < 0.6 ? "is-low" : ""} style={{ width: (row.original.online_rate_30d ?? 0) * 100 + "%" }} /></span><span>{formatRate(row.original.online_rate_30d)}</span></span>, enableSorting: true },
    { id: "history_30d", accessorKey: "history_30d", header: "近 30 天（左旧右新）", cell: ({ row }) => <StatusCells history={row.original.history_30d} />, enableSorting: false },
    { id: "last_change", accessorKey: "last_change", header: "最近变化", cell: ({ row }) => row.original.last_change ? <span className="si-last-change"><strong>{row.original.last_change_at ?? "近期"}</strong><small>{row.original.last_change}</small></span> : <span className="si-muted">—</span>, enableSorting: true },
  ];
}

export function InventoryPage() {
  const { id = "kingsyard" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState<ListQuery<SkuStockFilters>>(INITIAL_QUERY);
  const [selectedRow, setSelectedRow] = useState<SkuStockView | null>(null);
  const [report, setReport] = useState<string | null | undefined>(undefined);
  const [feedback, setFeedback] = useState("");
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [syncMessage, setSyncMessage] = useState("");

  useEffect(() => { setQuery(INITIAL_QUERY); setSelectedRow(null); }, [id]);
  useEffect(() => {
    if (!activeRunId) return;
    const unsubscribeProgress = api.jobs.onProgress((progress) => {
      if (progress.runId === activeRunId) setSyncMessage(progress.message);
    });
    const unsubscribeFinished = api.jobs.onFinished((result) => {
      if (result.runId !== activeRunId) return;
      setSyncMessage(result.summary);
      setFeedback(result.status === "ok" ? "库存同步已完成。" : result.summary);
      setActiveRunId(null);
      void queryClient.invalidateQueries({ queryKey: ["inventory-summary", id] });
      void queryClient.invalidateQueries({ queryKey: ["inventory-skus", id] });
    });
    return () => { unsubscribeProgress(); unsubscribeFinished(); };
  }, [activeRunId, id, queryClient]);

  const projectQuery = useQuery({ queryKey: ["project", id], queryFn: () => api.projects.get(id) });
  const summaryQuery = useQuery({ queryKey: ["inventory-summary", id], queryFn: () => api.inventory.summary(id, 30) });
  const skuQuery = useQuery({ queryKey: ["inventory-skus", id, query], queryFn: () => api.inventory.listSkus(id, query), placeholderData: (previous) => previous });
  const columns = useMemo(inventoryColumns, []);
  const summary = summaryQuery.data;
  const project = projectQuery.data?.summary;
  const kpis: Kpi[] = summary?.kpis ?? [];
  const statusFilter = query.filters?.status ?? "all";
  const categoryFilter = query.filters?.category ?? "all";

  const onSearch = useCallback((search: string) => setQuery((current) => ({ ...current, page: 1, search: search || undefined })), []);
  const onStatusChange = (value: string | undefined) => setQuery((current) => ({ ...current, page: 1, filters: { ...current.filters, status: !value || value === "all" ? undefined : value as SkuStockFilters["status"] } }));
  const onCategoryChange = (value: string | undefined) => setQuery((current) => ({ ...current, page: 1, filters: { ...current.filters, category: !value || value === "all" ? undefined : value } }));
  const sortByRate = () => setQuery((current) => ({ ...current, page: 1, sort: { field: "online_rate_30d", dir: current.sort?.field === "online_rate_30d" && current.sort.dir === "asc" ? "desc" : "asc" } }));

  const exportCsv = async () => {
    try {
      const path = await api.inventory.exportCsv(id, query);
      await api.shell.openPath(path);
      setFeedback("CSV 已导出。");
    } catch (cause) { setFeedback(apiErrorMessage(cause, "导出失败。")); }
  };
  const openReport = async () => {
    try { setReport(await api.inventory.dailyReport(id, summary?.as_of ?? new Date().toISOString().slice(0, 10))); }
    catch (cause) { setFeedback(apiErrorMessage(cause, "今日日报读取失败。")); }
  };
  const runSync = async () => {
    if (!project) return;
    try {
      setFeedback(""); setSyncMessage("正在启动库存同步…");
      const run = await api.jobs.run({ projectPath: project.path, job: "daily" });
      setActiveRunId(run.runId);
    } catch (cause) { setSyncMessage(""); setFeedback(apiErrorMessage(cause, "同步任务启动失败。")); }
  };

  const tableToolbar = (
    <div className="si-inventory-toolbar">
      <div className="si-inventory-toolbar-top">
        <h2>SKU 库存明细</h2>
        <SearchInput value={query.search ?? ""} onSearch={onSearch} label="搜索 SKU 库存" placeholder="搜索 SKU、标题、变体" />
        <Button size="small" onClick={sortByRate}>按在线率排序</Button>
        <span className="si-table-total">显示 {skuQuery.data?.rows.length ?? 0} / {skuQuery.data?.total.toLocaleString("zh-CN") ?? "—"} 个 SKU</span>
      </div>
      <div className="si-inventory-filters">
        <span className="si-filter-label">状态</span>
        {stockOptions.map((option) => <FilterPill key={option.value} currentValue={statusFilter} value={option.value} onValueChange={onStatusChange}>{option.label}</FilterPill>)}
        <span className="si-filter-label si-filter-category-label">分类</span>
        <FilterPill currentValue={categoryFilter} value="all" onValueChange={onCategoryChange}>全部</FilterPill>
        {(summary?.category_rates ?? []).map((category) => <FilterPill key={category.category} currentValue={categoryFilter} value={category.category} onValueChange={onCategoryChange}>{category.category}</FilterPill>)}
      </div>
    </div>
  );

  if (projectQuery.isLoading || summaryQuery.isLoading) return <div className="si-page-loading" role="status">正在加载库存数据…</div>;
  if (projectQuery.isError || summaryQuery.isError || !summary || !project) return <div className="si-page-error" role="alert">库存页面加载失败。<button type="button" onClick={() => { void projectQuery.refetch(); void summaryQuery.refetch(); }}>重试</button></div>;

  return (
    <div className="si-page si-inventory-page">
      <header className="si-project-page-heading">
        <div className="si-project-title-line">
          <h1>{project.name}</h1><code>{project.domain} · {platformName(project)}</code>
          {project.sync.state === "ok" && <Chip tone="ok">{dateTime(project.sync.at)} 同步成功</Chip>}
          {project.sync.state !== "ok" && <Chip tone={project.sync.state === "failed" ? "danger" : "warn"}>{project.sync.state === "failed" ? "同步失败" : project.sync.state === "running" ? "同步中" : "待处理"}</Chip>}
        </div>
        <div className="si-page-actions">
          <Button icon={<Download size={15} />} onClick={() => void exportCsv()}>导出 CSV</Button>
          <Button icon={<FileText size={15} />} onClick={() => void openReport()}>查看今日日报</Button>
          <Button variant="primary" icon={<RefreshCw size={15} />} disabled={Boolean(activeRunId)} onClick={() => void runSync()}>{activeRunId ? "同步中…" : "立即同步"}</Button>
        </div>
      </header>
      <Tabs value="inventory" options={tabOptions} ariaLabel="项目页面" onChange={(tab) => navigate(tab === "settings" ? "/p/" + id + "/settings/config" : "/p/" + id + (tab === "overview" ? "" : "/" + tab))} />
      <div className="si-inventory-kpis">{kpis.slice(0, 5).map((metric) => <KpiCard key={metric.key} metric={metric} />)}</div>
      <div className="si-inventory-overview-grid">
        <TrendChart summary={summary} />
        <CategoryPanel summary={summary} project={project} />
      </div>
      {syncMessage && <div className="si-sync-progress" role="status"><span>{syncMessage}</span>{activeRunId && <span>同步任务运行中</span>}</div>}
      {feedback && <p className="si-feedback" role="status">{feedback}</p>}
      {skuQuery.isFetching && <p className="si-inventory-query-state" role="status">正在更新 SKU 列表…</p>}
      {skuQuery.isError && <div className="si-inventory-query-state is-error" role="alert"><span>SKU 列表更新失败{skuQuery.data ? "，当前保留上次结果。" : "。"}</span><Button size="small" onClick={() => void skuQuery.refetch()}>重试</Button></div>}
      <DataTable
        tableId="inventory.skus"
        scopeId={id}
        rows={skuQuery.data?.rows ?? []}
        total={skuQuery.data?.total ?? 0}
        columns={columns}
        query={query}
        onQueryChange={setQuery}
        onRowClick={setSelectedRow}
        getRowId={(row) => row.sku}
        maxHeight={560}
        emptyTitle="没有匹配的 SKU"
        emptyDescription="请修改搜索文字或库存筛选条件。"
        toolbar={tableToolbar}
      />
      <div className="si-inventory-legend" aria-label="库存状态图例">
        <span><i className="si-status-in" />有货</span><span><i className="si-status-out" />缺货</span><span><i className="si-status-preorder" />预售</span><span><i className="si-status-unknown" />未知 / 未上架</span>
        <span>数据：index/views/sku_stock.jsonl · 30 天趋势为示例数据</span>
      </div>
      <DetailPanel open={Boolean(selectedRow)} onClose={() => setSelectedRow(null)} title={selectedRow?.sku ?? "SKU 详情"}>
        {selectedRow && <StockDetail row={selectedRow} />}
      </DetailPanel>
      <DailyReportDialog report={report} onOpenChange={(open) => { if (!open) setReport(undefined); }} />
    </div>
  );
}
import "./inventory/page.css";
