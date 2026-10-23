import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { ExternalLink, FileDown, FolderOpen } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import type { BlogFilters, BlogPost, DraftRow, Keyword, KeywordFilters, ListQuery, ProjectDetail } from "@siteindex/shared";
import { api } from "../api";
import { Button, Chip, DataTable, DetailPanel, FilterPill, KpiCard, SearchInput, Segmented, Tabs } from "../components";

type ContentView = "blog" | "keywords" | "drafts";
type IssueFilter = BlogFilters["issue"] | "all";
type RoleFilter = KeywordFilters["role"] | "all";
type StatusFilter = KeywordFilters["status"] | "all";
type DraftFilter = DraftRow["status"] | "all";
const projectTabs = [
  { value: "overview", label: "概览" }, { value: "inventory", label: "库存" }, { value: "products", label: "产品" },
  { value: "seo", label: "SEO" }, { value: "content", label: "内容" }, { value: "edm", label: "EDM" },
  { value: "design", label: "设计" }, { value: "readme", label: "README" }, { value: "runs", label: "运行" }, { value: "settings", label: "设置" },
] as const;
const platformNames: Record<ProjectDetail["summary"]["platform"], string> = {
  magento: "Magento", wordpress: "WordPress", woocommerce: "WooCommerce", shopify: "Shopify", other: "其他平台",
};
const initialBlogQuery: ListQuery<BlogFilters> = { page: 1, pageSize: 20, filters: {} };
const initialKeywordQuery: ListQuery<KeywordFilters> = { page: 1, pageSize: 20, filters: {} };
const blogIssues: { value: IssueFilter; label: string }[] = [
  { value: "all", label: "全部" }, { value: "no_links", label: "无站内链接" },
  { value: "no_schema", label: "缺 schema" }, { value: "links_oos", label: "链接缺货产品" },
];
const roleOptions: { value: RoleFilter; label: string }[] = [
  { value: "all", label: "全部" }, { value: "primary", label: "主词" }, { value: "secondary", label: "次词" },
];
const statusOptions: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "全部状态" }, { value: "live", label: "已上线" }, { value: "planned", label: "计划" }, { value: "drafting", label: "撰写中" },
];
const draftOptions: { value: DraftFilter; label: string }[] = [
  { value: "all", label: "全部草稿" }, { value: "brief", label: "Brief" }, { value: "draft", label: "草稿" }, { value: "published", label: "已发布" },
];
const intentLabels: Record<Keyword["intent"], string> = { informational: "信息型", commercial: "商业调研", transactional: "交易型", navigational: "导航型" };
const keywordStatusLabels: Record<Keyword["status"], string> = { planned: "计划", drafting: "撰写中", live: "已上线" };
const draftStatusLabels: Record<DraftRow["status"], string> = { brief: "Brief", draft: "草稿", published: "已发布" };

function displayPath(url: string | null): string { if (!url) return "未分配"; try { return new URL(url).pathname; } catch { return url; } }
function csvCell(value: unknown): string { return '"' + String(value ?? "").replaceAll('"', '""') + '"'; }
function downloadCsv(filename: string, header: string[], rows: unknown[][]) {
  const csv = [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
  const objectUrl = URL.createObjectURL(new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a"); anchor.href = objectUrl; anchor.download = filename; anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
}

function blogColumns(): ColumnDef<BlogPost, unknown>[] {
  return [
    { id: "title", accessorKey: "title", header: "标题", cell: ({ row }) => <span className="si-content-title-cell"><strong>{row.original.title}</strong><code>{row.original.slug}</code></span>, enableSorting: true },
    { id: "published_at", accessorKey: "published_at", header: "发布", cell: ({ row }) => <code className="si-content-date">{row.original.published_at}</code>, enableSorting: true },
    { id: "word_count", accessorKey: "word_count", header: "字数", cell: ({ row }) => row.original.word_count ?? "—", enableSorting: true },
    { id: "primary_keyword", accessorKey: "primary_keyword", header: "主关键词", cell: ({ row }) => row.original.primary_keyword || <span className="si-muted">未登记</span>, enableSorting: true },
    { id: "links_internal", accessorKey: "links_internal", header: "内链 出/入", cell: ({ row }) => (row.original.links_internal.length + " / " + (row.original.links_in ?? 0)), enableSorting: false },
    { id: "links_products", accessorKey: "links_products", header: "链接产品", cell: ({ row }) => row.original.linked_out_of_stock?.length ? <Chip tone="warn">{row.original.linked_out_of_stock.length} · 含缺货</Chip> : <Chip tone="neutral">{row.original.links_products.length}</Chip>, enableSorting: false },
    { id: "schema", accessorKey: "has_faq", header: "Schema", cell: ({ row }) => row.original.has_faq ? <Chip tone="ok">BlogPosting · FAQ</Chip> : <Chip tone="danger">缺失</Chip>, enableSorting: true },
    { id: "impressions", header: "展现", cell: () => "—", meta: { reserved: true } },
    { id: "clicks", header: "点击", cell: () => "—", meta: { reserved: true } },
  ];
}

function keywordColumns(): ColumnDef<Keyword, unknown>[] {
  return [
    { id: "keyword", accessorKey: "keyword", header: "关键词", cell: ({ row }) => <span className="si-content-keyword-cell"><strong>{row.original.keyword}</strong><small>{intentLabels[row.original.intent]}</small></span>, enableSorting: true },
    { id: "role", accessorKey: "role", header: "类型", cell: ({ row }) => <Chip tone={row.original.role === "primary" ? "info" : "neutral"}>{row.original.role === "primary" ? "主词" : "次词"}</Chip>, enableSorting: true },
    { id: "target_url", accessorKey: "target_url", header: "目标页面", cell: ({ row }) => <code className="si-content-url">{displayPath(row.original.target_url)}</code>, enableSorting: true },
    { id: "cluster", accessorKey: "cluster", header: "主题簇", enableSorting: true },
    { id: "status", accessorKey: "status", header: "状态", cell: ({ row }) => <Chip tone={row.original.status === "live" ? "ok" : row.original.status === "drafting" ? "warn" : "neutral"}>{keywordStatusLabels[row.original.status]}</Chip>, enableSorting: true },
    { id: "search_volume", accessorKey: "search_volume", header: "搜索量", cell: ({ row }) => row.original.search_volume ?? "—", meta: { reserved: true } },
    { id: "current_rank", accessorKey: "current_rank", header: "排名", cell: ({ row }) => row.original.current_rank ?? "—", meta: { reserved: true } },
  ];
}

function draftColumns(): ColumnDef<DraftRow, unknown>[] {
  return [
    { id: "date", accessorKey: "date", header: "日期", cell: ({ row }) => <code className="si-content-date">{row.original.date}</code>, enableSorting: true },
    { id: "slug", accessorKey: "slug", header: "Slug", cell: ({ row }) => <code className="si-content-url">{row.original.slug}</code>, enableSorting: true },
    { id: "folder", accessorKey: "folder", header: "文件夹", enableSorting: true },
    { id: "files", accessorKey: "files", header: "文件", cell: ({ row }) => row.original.files.length + " 个", enableSorting: true },
    { id: "status", accessorKey: "status", header: "状态", cell: ({ row }) => <Chip tone={row.original.status === "published" ? "ok" : row.original.status === "draft" ? "info" : "neutral"}>{draftStatusLabels[row.original.status]}</Chip>, enableSorting: true },
  ];
}

export function ContentPage() {
  const { id = "kingsyard" } = useParams();
  const navigate = useNavigate();
  const [view, setView] = useState<ContentView>("blog");
  const [blogQuery, setBlogQuery] = useState(initialBlogQuery);
  const [keywordQuery, setKeywordQuery] = useState(initialKeywordQuery);
  const [draftQuery, setDraftQuery] = useState<ListQuery>({ page: 1, pageSize: 20, filters: {} });
  const [draftStatus, setDraftStatus] = useState<DraftFilter>("all");
  const [selected, setSelected] = useState<BlogPost | Keyword | DraftRow | null>(null);
  const [feedback, setFeedback] = useState("");
  const projectQuery = useQuery({ queryKey: ["project", id], queryFn: () => api.projects.get(id) });
  const summaryQuery = useQuery({ queryKey: ["content", "summary", id], queryFn: () => api.content.summary(id) });
  const blogListQuery = useQuery({ queryKey: ["content", "blogs", id, blogQuery], queryFn: () => api.content.listBlog(id, blogQuery) });
  const keywordListQuery = useQuery({ queryKey: ["content", "keywords", id, keywordQuery], queryFn: () => api.content.listKeywords(id, keywordQuery) });
  const draftListQuery = useQuery({ queryKey: ["content", "drafts", id], queryFn: () => api.content.listDrafts(id) });
  const project = projectQuery.data?.summary;
  const summary = summaryQuery.data;
  const blogs = blogListQuery.data;
  const keywords = keywordListQuery.data;
  const drafts = draftListQuery.data ?? [];
  const issueCounts = useMemo(() => ({
    noLinks: summary?.kpis.find((item) => item.key === "no_links")?.value ?? "0",
    noSchema: summary?.kpis.find((item) => item.key === "no_schema")?.value ?? "0",
    oos: summary?.kpis.find((item) => item.key === "links_oos")?.value ?? "0",
  }), [summary]);
  const viewOptions = [
    { value: "blog" as const, label: "博客文章 " + (blogs?.total ?? 0) },
    { value: "keywords" as const, label: "关键词映射 " + (keywords?.total ?? 0) },
    { value: "drafts" as const, label: "草稿 " + drafts.length },
  ];
  const activeQuery = view === "blog" ? blogListQuery : view === "keywords" ? keywordListQuery : draftListQuery;
  const filteredDrafts = useMemo(() => drafts.filter((row) => (draftStatus === "all" || row.status === draftStatus) && (!draftQuery.search || [row.slug, row.folder, row.files.join(" ")].join(" ").toLowerCase().includes(draftQuery.search.toLowerCase()))), [drafts, draftStatus, draftQuery.search]);
  const sortedDrafts = useMemo(() => {
    const rows = [...filteredDrafts];
    if (draftQuery.sort) rows.sort((a, b) => String(a[draftQuery.sort!.field as keyof DraftRow] ?? "").localeCompare(String(b[draftQuery.sort!.field as keyof DraftRow] ?? "")) * (draftQuery.sort!.dir === "asc" ? 1 : -1));
    return rows;
  }, [filteredDrafts, draftQuery.sort]);
  const pagedDrafts = sortedDrafts.slice((draftQuery.page - 1) * draftQuery.pageSize, draftQuery.page * draftQuery.pageSize);
  const blogColumnDefs = useMemo(blogColumns, []);
  const keywordColumnDefs = useMemo(keywordColumns, []);
  const draftColumnDefs = useMemo(draftColumns, []);

  const setSearch = (search: string) => {
    if (view === "blog") setBlogQuery((current) => ({ ...current, page: 1, search: search || undefined }));
    else if (view === "keywords") setKeywordQuery((current) => ({ ...current, page: 1, search: search || undefined }));
    else setDraftQuery((current) => ({ ...current, page: 1, search: search || undefined }));
  };
  const exportRows = async () => {
    try {
      if (view === "blog") {
        const result = await api.content.listBlog(id, { ...blogQuery, page: 1, pageSize: 0 });
        downloadCsv(id + "-blog-content.csv", ["标题", "Slug", "发布日期", "字数", "主关键词", "内链出", "内链入", "链接产品", "缺货产品", "Schema"], result.rows.map((row) => [row.title, row.slug, row.published_at, row.word_count, row.primary_keyword, row.links_internal.join("; "), row.links_in, row.links_products.join("; "), row.linked_out_of_stock?.join("; "), row.has_faq ? "BlogPosting" : "缺失"]));
      } else if (view === "keywords") {
        const result = await api.content.listKeywords(id, { ...keywordQuery, page: 1, pageSize: 0 });
        downloadCsv(id + "-content-keywords.csv", ["关键词", "类型", "意图", "主题簇", "目标页面", "状态", "搜索量", "当前排名"], result.rows.map((row) => [row.keyword, row.role, row.intent, row.cluster, row.target_url, row.status, row.search_volume, row.current_rank]));
      } else downloadCsv(id + "-content-drafts.csv", ["日期", "Slug", "文件夹", "文件", "状态"], filteredDrafts.map((row) => [row.date, row.slug, row.folder, row.files.join("; "), row.status]));
      setFeedback("当前列表已导出 CSV。");
    } catch (cause) { setFeedback(cause instanceof Error ? cause.message : "导出失败。"); }
  };
  const openContentFolder = async () => {
    try { await api.folders.open(id, "内容"); }
    catch (cause) { setFeedback(cause instanceof Error ? cause.message : "无法打开内容文件夹。"); }
  };
  const onTabChange = (tab: typeof projectTabs[number]["value"]) => navigate(tab === "settings" ? "/p/" + id + "/settings/config" : "/p/" + id + (tab === "overview" ? "" : "/" + tab));

  if (projectQuery.isLoading || summaryQuery.isLoading || activeQuery.isLoading) return <div className="si-page-loading" role="status">正在加载内容数据…</div>;
  if (projectQuery.isError || summaryQuery.isError || activeQuery.isError || !project || !summary) return <div className="si-page-error" role="alert">内容数据加载失败。<button type="button" onClick={() => { void projectQuery.refetch(); void summaryQuery.refetch(); void activeQuery.refetch(); }}>重试</button></div>;

  return <div className="si-page si-content-page">
    <header className="si-project-page-heading">
      <div className="si-project-title-line"><h1>{project.name}</h1><code>{project.domain} · {platformNames[project.platform]}</code><Chip tone="info">示例数据</Chip></div>
      <div className="si-page-actions"><Button onClick={() => void exportRows()}><FileDown size={14} />导出 CSV</Button><Button onClick={() => void openContentFolder()}><FolderOpen size={14} />打开内容/文件夹</Button></div>
    </header>
    <Tabs value="content" options={projectTabs} ariaLabel="项目页面" onChange={onTabChange} />
    <div className="si-content-kpis">{summary.kpis.map((metric) => <KpiCard key={metric.key} metric={metric} />)}</div>
    <div className="si-content-toolbar si-content-toolbar-table">
      <Segmented value={view} options={viewOptions} onChange={setView} ariaLabel="内容视图" />
      <SearchInput value={(view === "blog" ? blogQuery : view === "keywords" ? keywordQuery : draftQuery).search ?? ""} onSearch={setSearch} label="搜索内容" placeholder={view === "keywords" ? "搜索关键词或主题簇" : "搜索标题或关键词"} />
      {view === "blog" && <div className="si-content-filter-row">{blogIssues.map((item) => <FilterPill key={item.value} currentValue={blogQuery.filters?.issue ?? "all"} value={item.value} onValueChange={(value) => setBlogQuery((current) => ({ ...current, page: 1, filters: { ...current.filters, issue: !value || value === "all" ? undefined : value } }))}>{item.label}{item.value === "no_links" ? " " + issueCounts.noLinks : item.value === "no_schema" ? " " + issueCounts.noSchema : item.value === "links_oos" ? " " + issueCounts.oos : ""}</FilterPill>)}</div>}
      {view === "keywords" && <div className="si-content-filter-row">{roleOptions.map((item) => <FilterPill key={item.value} currentValue={keywordQuery.filters?.role ?? "all"} value={item.value} onValueChange={(value) => setKeywordQuery((current) => ({ ...current, page: 1, filters: { ...current.filters, role: !value || value === "all" ? undefined : value } }))}>{item.label}</FilterPill>)}{statusOptions.map((item) => <FilterPill key={item.value} currentValue={keywordQuery.filters?.status ?? "all"} value={item.value} onValueChange={(value) => setKeywordQuery((current) => ({ ...current, page: 1, filters: { ...current.filters, status: !value || value === "all" ? undefined : value } }))}>{item.label}</FilterPill>)}</div>}
      {view === "drafts" && <div className="si-content-filter-row">{draftOptions.map((item) => <FilterPill key={item.value} currentValue={draftStatus} value={item.value} onValueChange={(value) => { setDraftStatus(value ?? "all"); setDraftQuery((current) => ({ ...current, page: 1 })); }}>{item.label}</FilterPill>)}</div>}
      {view === "blog" && <span className="si-content-total">共 {blogs?.total ?? 0} 篇</span>}
      {view === "keywords" && <span className="si-content-total">共 {keywords?.total ?? 0} 个</span>}
      {view === "drafts" && <span className="si-content-total">共 {filteredDrafts.length} 篇</span>}
    </div>
    {feedback && <p className="si-feedback" role="status">{feedback}</p>}
    <div className="si-content-table-frame">
      {view === "blog" && <DataTable tableId="content.blog" rows={blogs?.rows ?? []} total={blogs?.total ?? 0} columns={blogColumnDefs} query={blogQuery} onQueryChange={setBlogQuery} onRowClick={setSelected} getRowId={(row) => row.slug} maxHeight={520} showPagination emptyTitle="没有博客文章" emptyDescription="调整筛选条件或检查内容目录。" />}
      {view === "keywords" && <DataTable tableId="content.keywords" rows={keywords?.rows ?? []} total={keywords?.total ?? 0} columns={keywordColumnDefs} query={keywordQuery} onQueryChange={setKeywordQuery} onRowClick={setSelected} getRowId={(row) => row.keyword} maxHeight={520} showPagination emptyTitle="没有关键词" emptyDescription="在关键词台账中添加目标关键词。" />}
      {view === "drafts" && <DataTable tableId="content.drafts" rows={pagedDrafts} total={filteredDrafts.length} columns={draftColumnDefs} query={draftQuery} onQueryChange={setDraftQuery} onRowClick={setSelected} getRowId={(row) => row.slug} maxHeight={520} showPagination emptyTitle="没有草稿" emptyDescription="检查内容文件夹中的 brief 和草稿文件。" />}
    </div>
    <p className="si-content-data-note">数据：<code>index/content/blog_index.jsonl</code> · <code>index/content/keywords.jsonl</code> · 灰色列为 GSC / 关键词工具预留位</p>
    <DetailPanel open={Boolean(selected)} onClose={() => setSelected(null)} title={selected && "title" in selected ? selected.title : selected && "keyword" in selected ? selected.keyword : selected?.slug ?? "内容详情"}>
      {selected && "title" in selected && <div className="si-content-detail"><div><span>Slug</span><code>{selected.slug}</code></div><div><span>发布日期</span><code>{selected.published_at}</code></div><div><span>类别</span>{selected.category || "—"}</div><div><span>字数</span>{selected.word_count ?? "未统计"}</div><div><span>主关键词</span>{selected.primary_keyword || "未登记"}</div><div><span>内链</span>{selected.links_internal.length} 出 / {selected.links_in ?? 0} 入</div><div><span>链接产品</span>{selected.links_products.join("、") || "无"}</div><div><span>缺货产品</span>{selected.linked_out_of_stock?.join("、") || "无"}</div><div><span>Schema</span>{selected.has_faq ? "BlogPosting / FAQ" : "缺失"}</div><div className="full"><span>Meta description</span>{selected.meta_description || "缺失"}</div><Button size="small" onClick={() => void api.shell.openExternal(selected.url)}><ExternalLink size={13} />打开文章</Button></div>}
      {selected && "keyword" in selected && <div className="si-content-detail"><div><span>类型</span>{selected.role === "primary" ? "主词" : "次词"}</div><div><span>搜索意图</span>{intentLabels[selected.intent]}</div><div><span>主题簇</span>{selected.cluster}</div><div><span>状态</span>{keywordStatusLabels[selected.status]}</div><div><span>目标页面</span><code>{selected.target_url || "未分配"}</code></div><div><span>搜索量</span>{selected.search_volume ?? "预留"}</div><div><span>当前排名</span>{selected.current_rank ?? "预留"}</div><div className="full"><span>备注</span>{selected.note || "—"}</div>{selected.target_url && <Button size="small" onClick={() => void api.shell.openExternal(selected.target_url!)}><ExternalLink size={13} />打开目标页面</Button>}</div>}
      {selected && "date" in selected && <div className="si-content-detail"><div><span>日期</span><code>{selected.date}</code></div><div><span>文件夹</span>{selected.folder}</div><div><span>状态</span>{draftStatusLabels[selected.status]}</div><div className="full"><span>文件</span>{selected.files.join("、") || "无"}</div><Button size="small" onClick={() => void api.folders.open(id, "内容")}><FolderOpen size={13} />打开内容文件夹</Button></div>}
    </DetailPanel>
  </div>;
}
import "./content/page.css";
