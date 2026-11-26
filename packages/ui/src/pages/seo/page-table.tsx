import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { useSearchParams } from "react-router-dom";
import { SEO_RULE_LABELS } from "@siteindex/shared";
import type { ListQuery, PageType, SeoPageTableFilters, SeoPageTableQuery, SeoPageTableRow, SeoSummary, Severity } from "@siteindex/shared";
import { api, apiErrorMessage } from "../../api";
import { ApiErrorNotice, Button, Chip, DataTable, FilterBar, SearchInput, SummaryLine, formatDateTime, useToast } from "../../components";
import { SeoFilterChip, SeoMultiFilter, SeoSingleFilter } from "./filters";
import { searchTextFromSearchParams, seoRouteFiltersFromSearchParams, updateSeoSearchParams } from "./query-params";

const pageTypes: { value: PageType | "all"; label: string }[] = [
  { value: "all", label: "全部" }, { value: "home", label: "首页" }, { value: "collection", label: "分类" },
  { value: "product", label: "产品" }, { value: "blog", label: "博客" }, { value: "page", label: "页面" }, { value: "other", label: "其他" },
];
const pageTypeLabels: Record<PageType, string> = { home: "首页", collection: "分类", product: "产品", blog: "博客", page: "页面", other: "其他" };
const severityLabels: Record<Severity, string> = { high: "高", mid: "中", low: "低" };
const ruleLabels: Record<string, string> = SEO_RULE_LABELS;
const indexOptions = [
  { value: "all", label: "全部" }, { value: "yes", label: "已收录" },
  { value: "no", label: "未收录" }, { value: "unchecked", label: "未检查" },
] as const;
const summaryFilters = new Set(["open", "new", "unindexed", "fixed"]);

function path(url: string) {
  try { const value = new URL(url); return value.pathname + value.search; }
  catch { return url; }
}

export function seoPageTableColumns(rows: readonly Pick<SeoPageTableRow, "links_internal_in" | "links_internal_out" | "last_issue_change_date">[] = []): ColumnDef<SeoPageTableRow, unknown>[] {
  const linksInEmpty = rows.length > 0 && rows.every((row) => row.links_internal_in == null);
  const linksOutEmpty = rows.length > 0 && rows.every((row) => row.links_internal_out == null);
  const issueDateEmpty = rows.length > 0 && rows.every((row) => row.last_issue_change_date == null);
  return [
    { id: "url", accessorKey: "url", header: "URL", meta: { width: 160, grow: 2, minWidth: 130, text: "single" }, enableHiding: false, cell: ({ row }) =>
      <code className="si-seo-url" title={row.original.url}>{path(row.original.url)}</code>, enableSorting: true },
    { id: "title", accessorKey: "title", header: "标题", meta: { width: 170, grow: 2, minWidth: 150, text: "single" }, enableHiding: false, cell: ({ row }) =>
      <span className="si-seo-page-title">{row.original.title || "无 Title"}</span>, enableSorting: true },
    { id: "page_type", accessorKey: "page_type", header: "类型", meta: { width: 80, grow: 0, minWidth: 80, text: "single" }, cell: ({ row }) => pageTypeLabels[row.original.page_type], enableSorting: true },
    { id: "google_indexed", accessorKey: "google_indexed", header: "收录", meta: { width: 88, grow: 0, minWidth: 88, text: "single" }, cell: ({ row }) =>
      <Chip tone={row.original.google_indexed === true ? "ok" : row.original.google_indexed === false ? "danger" : "neutral"}>{row.original.google_indexed === true ? "已收录" : row.original.google_indexed === false ? "未收录" : "未检查"}</Chip>, enableSorting: true },
    { id: "open_high", header: "待处理问题", meta: { width: 100, grow: 0, minWidth: 96, align: "end", text: "single" }, cell: ({ row }) => {
      const counts = row.original.open_issue_counts;
      return counts.high + counts.mid + counts.low ? <span className="si-seo-counts">高 {counts.high} · 中 {counts.mid} · 低 {counts.low}</span> : "—";
    }, enableSorting: true },
    { id: "links_internal_in", accessorKey: "links_internal_in", header: "入链", meta: { width: 64, grow: 0, minWidth: 64, align: "end", text: "single", ...(linksInEmpty ? { allEmpty: true } : {}) }, cell: ({ row }) => <span className="si-seo-number">{row.original.links_internal_in ?? "—"}</span>, enableSorting: true },
    { id: "links_internal_out", accessorKey: "links_internal_out", header: "出链", meta: { width: 64, grow: 0, minWidth: 64, align: "end", text: "single", ...(linksOutEmpty ? { allEmpty: true } : {}) }, cell: ({ row }) => <span className="si-seo-number">{row.original.links_internal_out ?? "—"}</span>, enableSorting: true },
    { id: "last_issue_change_date", accessorKey: "last_issue_change_date", header: "最近问题变化", meta: { width: 100, grow: 0, minWidth: 88, text: "single", ...(issueDateEmpty ? { allEmpty: true } : {}) }, cell: ({ row }) => <code className="si-seo-date">{row.original.last_issue_change_date?.slice(5) ?? "—"}</code>, enableSorting: true },
  ];
}

function queryFromUrl(params: URLSearchParams): ListQuery<SeoPageTableFilters> {
  const route = seoRouteFiltersFromSearchParams(params);
  const summary = params.get("summary");
  return { page: 1, pageSize: 50, search: searchTextFromSearchParams(params) || undefined,
    filters: { ...route.issues, ...route.pages,
      ...(summary && summaryFilters.has(summary) ? { summary: summary as NonNullable<SeoPageTableFilters["summary"]> } : {}) } };
}

export function SeoPageTable({ id, summary, onOpen }: { id: string; summary?: SeoSummary; onOpen: (url: string) => void }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [query, setQuery] = useState<ListQuery<SeoPageTableFilters>>(() => queryFromUrl(searchParams));
  const [selectedPages, setSelectedPages] = useState<SeoPageTableRow[]>([]);
  const [selectionReset, setSelectionReset] = useState(0);
  const [updating, setUpdating] = useState(false);
  useEffect(() => { setQuery((current) => ({ ...current, ...queryFromUrl(searchParams) })); }, [searchParams]);
  useEffect(() => { setSelectedPages([]); setSelectionReset((value) => value + 1); }, [query]);
  const pageRows = useQuery({ queryKey: ["seo", "pageRows", id, query], queryFn: () => api.seo.listPageRows!(id, query as SeoPageTableQuery), placeholderData: keepPreviousData });
  const defs = useMemo(() => seoPageTableColumns(pageRows.data?.rows ?? []), [pageRows.data?.rows]);
  const filters = query.filters ?? {};
  const write = (patch: Record<string, string | string[] | null>) =>
    setSearchParams((current) => updateSeoSearchParams(current, patch), { replace: true });
  const setFilter = (key: keyof SeoPageTableFilters, value: string | string[] | undefined, urlKey: string = key) => {
    setQuery((current) => ({ ...current, page: 1, filters: { ...current.filters, [key]: value } }));
    write({ [urlKey]: value == null ? null : value });
  };
  const selectedRules = filters.rules ?? [];
  const targets = selectedPages.flatMap((page) => page.open_issue_targets);
  const pageSummary = pageRows.data?.summary;
  const summaryItems = pageSummary ? ([
    { id: "open", label: "待处理问题页", value: pageSummary.open_pages },
    { id: "new", label: "本次新增", value: pageSummary.new_pages },
    { id: "unindexed", label: "未收录", value: pageSummary.unindexed_pages },
    { id: "fixed", label: "已修复", value: pageSummary.fixed_pages },
  ] as const).map((item) => ({ ...item, active: filters.summary === item.id,
    onToggle: () => setFilter("summary", filters.summary === item.id ? undefined : item.id) })) : [];
  const ruleOptions = (summary?.issue_counts ?? []).map((item) => ({ value: item.rule, label: item.label || ruleLabels[item.rule] || item.rule, count: item.count }));
  const selected = [
    ...(filters.severity ? [{ label: `严重级别 · ${severityLabels[filters.severity]}`, remove: () => setFilter("severity", undefined) }] : []),
    ...(filters.status ? [{ label: `状态 · ${{ open: "待处理", fixed: "已处理", ignored: "已忽略" }[filters.status]}`, remove: () => setFilter("status", undefined) }] : []),
    ...selectedRules.map((rule) => ({ label: `问题类型 · ${ruleLabels[rule] ?? rule}`, remove: () => setFilter("rules", selectedRules.filter((item) => item !== rule), "rule") })),
    ...(filters.page_type ? [{ label: `页面类型 · ${pageTypeLabels[filters.page_type]}`, remove: () => setFilter("page_type", undefined) }] : []),
    ...(filters.indexed ? [{ label: `收录 · ${indexOptions.find((item) => item.value === filters.indexed)?.label}`, remove: () => setFilter("indexed", undefined) }] : []),
  ];
  const markSelected = async () => {
    if (!api.seo.setIssueStatus || !targets.length || updating) return;
    if (!window.confirm(`将所选 ${selectedPages.length} 个页面的 ${targets.length} 条待处理问题标记为已处理？\n影响范围：仅所选页面的待处理问题。`)) return;
    setUpdating(true);
    try {
      const result = await api.seo.setIssueStatus(id, { targets, status: "fixed" });
      await Promise.all(["pageRows", "summary", "issues", "pageBrief", "issueCandidates", "rule-settings"]
        .map((key) => queryClient.invalidateQueries({ queryKey: ["seo", key, id] })));
      await queryClient.invalidateQueries({ queryKey: ["overview", id] });
      toast.success(`已更新 ${result.updated} 条`);
      setSelectedPages([]);
      setSelectionReset((value) => value + 1);
    } catch (cause) { toast.error(apiErrorMessage(cause, "批量处理 SEO 问题失败。")); }
    finally { setUpdating(false); }
  };

  return <>
    {pageSummary && <SummaryLine items={summaryItems} ariaLabel="SEO 摘要"
      timeNote={summary?.crawled_at ? `SEO 抓取于 ${formatDateTime(summary.crawled_at)}` : undefined} />}
    {selected.length > 0 && <div className="si-seo-selected-filters" aria-label="已选筛选条件">{selected.map((item) => <SeoFilterChip key={item.label} label={item.label} onRemove={item.remove} />)}</div>}
    {pageRows.isLoading ? <div className="si-query-loading" role="status">正在加载 SEO 页面…</div>
      : pageRows.isError ? <ApiErrorNotice label="SEO 页面列表加载失败。" error={pageRows.error} onRetry={() => void pageRows.refetch()} />
        : <DataTable key={selectionReset} tableId="seo.pageRows" rows={pageRows.data?.rows ?? []} total={pageRows.data?.total ?? 0} columns={defs}
          query={query} onQueryChange={setQuery} getRowId={(row) => row.url} onRowClick={(row) => onOpen(row.url)} height="fill" rowHeight={40}
          selectable={Boolean(api.seo.setIssueStatus)} onSelectionChange={setSelectedPages}
          emptyTitle="没有匹配的页面" emptyDescription="调整筛选条件，或重新抓取 SEO 数据。"
          toolbar={selectedPages.length ? <div className="si-seo-selection-toolbar"><span>已选 {selectedPages.length} 页 · 待处理问题 {targets.length} 条</span>
            <Button size="small" disabled={!targets.length || updating} onClick={() => void markSelected()}>{updating ? "处理中…" : "标记所选页面的待处理问题"}</Button>
          </div> : <div className="si-seo-table-toolbar">
            <SearchInput value={query.search ?? ""} onSearch={(value) => { setQuery((current) => ({ ...current, page: 1, search: value || undefined })); write({ q: value || null }); }} label="搜索 SEO 页面" placeholder="搜索 URL、标题或问题" />
            <FilterBar className="si-seo-filterbar">
              <SeoSingleFilter label="页面类型" value={filters.page_type ?? "all"} options={pageTypes} onChange={(value) => setFilter("page_type", value === "all" ? undefined : value)} />
              <SeoSingleFilter label="收录状态" value={filters.indexed ?? "all"} options={[...indexOptions]} onChange={(value) => setFilter("indexed", value === "all" ? undefined : value)} />
              <SeoSingleFilter label="严重级别" value={filters.severity ?? "all"} options={[{ value: "all", label: "全部" }, ...(["high", "mid", "low"] as const).map((value) => ({ value, label: severityLabels[value] }))]} onChange={(value) => setFilter("severity", value === "all" ? undefined : value)} />
              <SeoSingleFilter label="问题状态" value={filters.status ?? "all"} options={[{ value: "all", label: "全部" }, { value: "open", label: "待处理" }, { value: "fixed", label: "已处理" }, { value: "ignored", label: "已忽略" }]} onChange={(value) => setFilter("status", value === "all" ? undefined : value)} />
              <SeoMultiFilter label="问题类型" values={selectedRules} options={ruleOptions} onChange={(values) => setFilter("rules", values, "rule")} />
            </FilterBar><span className="si-seo-result-count">显示 {pageRows.data?.rows.length ?? 0} / {pageRows.data?.total ?? 0} 页</span>
          </div>} />}
  </>;
}
