import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { ExternalLink, FileDown } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import type { BlogFilters, BlogPost, JobProgress, JobResult, Keyword, KeywordFilters, ListQuery } from "@siteindex/shared";
import { api, apiErrorMessage } from "../api";
import { invalidateProjectSummary, projectQueryKeys } from "../project-queries";
import { ApiErrorNotice, Button, Chip, DataTable, DetailPanel, FilterBar, FilterPill, KpiCard, ProjectHeader, ProjectTabPanel, SearchInput, Segmented } from "../components";
import { blogIndexNotice, blogRecognitionCounts, blogRecognitionNeedsRecrawl, getBlogRecognitionConfigUpdatedAt, hasBlogRecognitionConfig } from "./content/blog-recognition";

type ContentView = "blog" | "keywords";
export const SHOW_KEYWORD_MAPPING = false;
type IssueFilter = BlogFilters["issue"] | "all";
type RoleFilter = KeywordFilters["role"] | "all";
type StatusFilter = KeywordFilters["status"] | "all";
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
const intentLabels: Record<Keyword["intent"], string> = { informational: "信息型", commercial: "商业调研", transactional: "交易型", navigational: "导航型" };
const keywordStatusLabels: Record<Keyword["status"], string> = { planned: "计划", drafting: "撰写中", live: "已上线" };

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
    { id: "title", accessorKey: "title", header: "标题", meta: { width: 320, grow: 2, minWidth: 220, text: "clamp2" }, cell: ({ row }) => <span className="si-content-title-cell"><strong>{row.original.title}</strong><code>{row.original.slug}</code></span>, enableSorting: true },
    { id: "published_at", accessorKey: "published_at", header: "发布", meta: { width: 112, grow: 0, minWidth: 100, text: "single" }, cell: ({ row }) => <code className="si-content-date">{row.original.published_at}</code>, enableSorting: true },
    { id: "word_count", accessorKey: "word_count", header: "字数", meta: { width: 76, grow: 0, minWidth: 68, align: "end", text: "single" }, cell: ({ row }) => row.original.word_count ?? "—", enableSorting: true },
    { id: "primary_keyword", accessorKey: "primary_keyword", header: "主关键词", meta: { width: 180, grow: 1, minWidth: 140, text: "single" }, cell: ({ row }) => row.original.primary_keyword || <span className="si-muted">未登记</span>, enableSorting: true },
    { id: "links_internal", accessorKey: "links_internal", header: "内链 出/入", meta: { width: 104, grow: 0, minWidth: 96, align: "end", text: "single" }, cell: ({ row }) => (row.original.links_internal.length + " / " + (row.original.links_in ?? 0)), enableSorting: false },
    { id: "links_products", accessorKey: "links_products", header: "链接产品", meta: { width: 108, grow: 0, minWidth: 96, text: "single" }, cell: ({ row }) => row.original.linked_out_of_stock?.length ? <Chip tone="warn">{row.original.linked_out_of_stock.length} · 含缺货</Chip> : <Chip tone="neutral">{row.original.links_products.length}</Chip>, enableSorting: false },
    { id: "schema", accessorKey: "has_faq", header: "Schema", meta: { width: 128, grow: 0, minWidth: 116, text: "single" }, cell: ({ row }) => row.original.has_faq ? <Chip tone="ok">BlogPosting · FAQ</Chip> : <Chip tone="danger">缺失</Chip>, enableSorting: true },
    { id: "impressions", header: "展现", meta: { width: 88, grow: 0, minWidth: 80, reserved: true, text: "single" }, cell: () => "—" },
    { id: "clicks", header: "点击", meta: { width: 88, grow: 0, minWidth: 80, reserved: true, text: "single" }, cell: () => "—" },
  ];
}

function keywordColumns(): ColumnDef<Keyword, unknown>[] {
  return [
    { id: "keyword", accessorKey: "keyword", header: "关键词", meta: { width: 260, grow: 2, minWidth: 200, text: "clamp2" }, cell: ({ row }) => <span className="si-content-keyword-cell"><strong>{row.original.keyword}</strong><small>{intentLabels[row.original.intent]}</small></span>, enableSorting: true },
    { id: "role", accessorKey: "role", header: "类型", meta: { width: 84, grow: 0, minWidth: 76, text: "single" }, cell: ({ row }) => <Chip tone={row.original.role === "primary" ? "info" : "neutral"}>{row.original.role === "primary" ? "主词" : "次词"}</Chip>, enableSorting: true },
    { id: "target_url", accessorKey: "target_url", header: "目标页面", meta: { width: 320, grow: 2, minWidth: 220, text: "single" }, cell: ({ row }) => <code className="si-content-url">{displayPath(row.original.target_url)}</code>, enableSorting: true },
    { id: "cluster", accessorKey: "cluster", header: "主题簇", meta: { width: 170, grow: 1, minWidth: 130, text: "single" }, enableSorting: true },
    { id: "status", accessorKey: "status", header: "状态", meta: { width: 86, grow: 0, minWidth: 78, text: "single" }, cell: ({ row }) => <Chip tone={row.original.status === "live" ? "ok" : row.original.status === "drafting" ? "warn" : "neutral"}>{keywordStatusLabels[row.original.status]}</Chip>, enableSorting: true },
    { id: "search_volume", accessorKey: "search_volume", header: "搜索量", meta: { width: 92, grow: 0, minWidth: 84, align: "end", reserved: true, text: "single" }, cell: ({ row }) => row.original.search_volume ?? "—" },
    { id: "current_rank", accessorKey: "current_rank", header: "排名", meta: { width: 76, grow: 0, minWidth: 68, align: "end", reserved: true, text: "single" }, cell: ({ row }) => row.original.current_rank ?? "—" },
  ];
}

export function ContentPage() {
  const { id = "demo" } = useParams();
  const [view, setView] = useState<ContentView>("blog");
  const [blogQuery, setBlogQuery] = useState(initialBlogQuery);
  const [keywordQuery, setKeywordQuery] = useState(initialKeywordQuery);
  const [selected, setSelected] = useState<BlogPost | Keyword | null>(null);
  const [feedback, setFeedback] = useState("");
  const [recrawlRunId, setRecrawlRunId] = useState<string | null>(null);
  const [recrawlStarting, setRecrawlStarting] = useState(false);
  const [recrawlProgress, setRecrawlProgress] = useState("");
  const queryClient = useQueryClient();
  const projectQuery = useQuery({ queryKey: projectQueryKeys.detail(id), queryFn: () => api.projects.get(id) });
  const summaryQuery = useQuery({ queryKey: ["content", "summary", id], queryFn: () => api.content.summary(id) });
  const seoSummaryQuery = useQuery({ queryKey: ["seo", "summary", id], queryFn: () => api.seo.summary(id) });
  const jobHistoryQuery = useQuery({ queryKey: ["job-history", id], queryFn: () => api.jobs.history(id, 30) });
  const blogListQuery = useQuery({ queryKey: ["content", "blogs", id, blogQuery], queryFn: () => api.content.listBlog(id, blogQuery) });
  const keywordListQuery = useQuery({ queryKey: ["content", "keywords", id, keywordQuery], queryFn: () => api.content.listKeywords(id, keywordQuery) });
  const project = projectQuery.data?.summary;
  const summary = summaryQuery.data;
  const blogs = blogListQuery.data;
  const keywords = keywordListQuery.data;
  const blogConfig = projectQuery.data?.config.content;
  const blogConfigCounts = blogRecognitionCounts(blogConfig);
  const blogRecognitionConfigured = hasBlogRecognitionConfig(blogConfig);
  const blogConfigUpdatedAt = getBlogRecognitionConfigUpdatedAt(id);
  const latestSuccessfulWeeklyStartedAt = useMemo(() => [...(jobHistoryQuery.data ?? [])]
    .filter((run) => run.job === "weekly" && run.status === "ok" && run.finished_at)
    .sort((left, right) => Date.parse(right.started_at) - Date.parse(left.started_at))[0]?.started_at ?? null,
  [jobHistoryQuery.data]);
  const canCheckBlogFreshness = !jobHistoryQuery.isLoading && !jobHistoryQuery.isError;
  const blogNeedsRecrawl = canCheckBlogFreshness && blogRecognitionNeedsRecrawl(
    blogRecognitionConfigured, blogConfigUpdatedAt, latestSuccessfulWeeklyStartedAt,
  );
  const hasBlogFilters = Boolean(blogQuery.search || blogQuery.filters?.issue);
  const showBlogRecognitionEmpty = view === "blog" && blogs?.total === 0 && !hasBlogFilters;
  const lastRecognizedDate = seoSummaryQuery.data?.crawled_at?.slice(0, 10) ?? null;
  const blogListNotice = blogIndexNotice(blogConfig, blogConfigUpdatedAt, latestSuccessfulWeeklyStartedAt, blogs?.total ?? 0, lastRecognizedDate);
  const issueCounts = useMemo(() => ({
    noLinks: summary?.kpis.find((item) => item.key === "no_links")?.value ?? "0",
    noSchema: summary?.kpis.find((item) => item.key === "no_schema")?.value ?? "0",
    oos: summary?.kpis.find((item) => item.key === "links_oos")?.value ?? "0",
  }), [summary]);
  const viewOptions: { value: ContentView; label: string }[] = [
    { value: "blog" as const, label: "博客文章 " + (blogs?.total ?? 0) },
    ...(SHOW_KEYWORD_MAPPING ? [{ value: "keywords" as const, label: "关键词映射 " + (keywords?.total ?? 0) }] : []),
  ];
  const activeQuery = view === "blog" ? blogListQuery : keywordListQuery;
  const blogColumnDefs = useMemo(blogColumns, []);
  const keywordColumnDefs = useMemo(keywordColumns, []);

  useEffect(() => {
    if (!recrawlRunId) return;
    const unsubscribeProgress = api.jobs.onProgress((progress: JobProgress) => {
      if (progress.runId === recrawlRunId) setRecrawlProgress(progress.message);
    });
    const unsubscribeFinished = api.jobs.onFinished((result: JobResult) => {
      if (result.runId !== recrawlRunId) return;
      setRecrawlRunId(null);
      setRecrawlProgress("");
      setFeedback(result.status === "ok" ? "博客内容已重新抓取。" : result.summary);
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ["content", "summary", id] }),
        queryClient.invalidateQueries({ queryKey: ["content", "blogs", id] }),
        queryClient.invalidateQueries({ queryKey: ["seo", "summary", id] }),
        queryClient.invalidateQueries({ queryKey: ["job-history", id] }),
        invalidateProjectSummary(queryClient, id),
      ]);
    });
    return () => { unsubscribeProgress(); unsubscribeFinished(); };
  }, [recrawlRunId, id, queryClient]);

  const recrawlBlogs = async () => {
    if (!project?.path || recrawlStarting || recrawlRunId) return;
    setFeedback("");
    setRecrawlStarting(true);
    setRecrawlProgress("正在启动 SEO 抓取…");
    try {
      const run = await api.jobs.run({ projectPath: project.path, job: "weekly" });
      setRecrawlRunId(run.runId);
    } catch (cause) {
      setRecrawlProgress("");
      setFeedback(apiErrorMessage(cause, "重新抓取启动失败。"));
    } finally {
      setRecrawlStarting(false);
    }
  };

  const blogEmptyState = !blogRecognitionConfigured ? "unconfigured"
    : jobHistoryQuery.isError ? "history-error"
      : !canCheckBlogFreshness ? "checking"
        : blogNeedsRecrawl ? (latestSuccessfulWeeklyStartedAt ? "stale" : "never-crawled") : "no-match";

  const setSearch = (search: string) => {
    if (view === "blog") setBlogQuery((current) => ({ ...current, page: 1, search: search || undefined }));
    else setKeywordQuery((current) => ({ ...current, page: 1, search: search || undefined }));
  };
  const exportRows = async () => {
    try {
      if (view === "blog") {
        const result = await api.content.listBlog(id, { ...blogQuery, page: 1, pageSize: 0 });
        downloadCsv(id + "-blog-content.csv", ["标题", "Slug", "发布日期", "字数", "主关键词", "内链出", "内链入", "链接产品", "缺货产品", "Schema"], result.rows.map((row) => [row.title, row.slug, row.published_at, row.word_count, row.primary_keyword, row.links_internal.join("; "), row.links_in, row.links_products.join("; "), row.linked_out_of_stock?.join("; "), row.has_faq ? "BlogPosting" : "缺失"]));
      } else if (view === "keywords") {
        const result = await api.content.listKeywords(id, { ...keywordQuery, page: 1, pageSize: 0 });
        downloadCsv(id + "-content-keywords.csv", ["关键词", "类型", "意图", "主题簇", "目标页面", "状态", "搜索量", "当前排名"], result.rows.map((row) => [row.keyword, row.role, row.intent, row.cluster, row.target_url, row.status, row.search_volume, row.current_rank]));
      }
      setFeedback("当前列表已导出 CSV。");
    } catch (cause) { setFeedback(apiErrorMessage(cause, "导出失败。")); }
  };
  const openProjectFolder = async () => {
    try { await api.shell.openPath(projectQuery.data?.summary.path ?? ""); }
    catch (cause) { setFeedback(apiErrorMessage(cause, "无法打开项目文件夹。")); }
  };
  if (projectQuery.isLoading) return <div className="si-page-loading" role="status">正在加载项目信息…</div>;
  if (projectQuery.isError || !project) return <ApiErrorNotice page label="项目内容加载失败。" error={projectQuery.error} onRetry={() => void projectQuery.refetch()} />;

  return <div className="si-page si-content-page">
    <ProjectHeader project={project} activeTab="content" hasTabPanel actions={<><Button onClick={() => void exportRows()}><FileDown size={14} />导出 CSV</Button><Button onClick={() => void openProjectFolder()}>打开项目文件夹</Button></>} />
    <ProjectTabPanel projectId={project.id} tab="content">
    <div className="si-content-recognition-summary" role="status">
      <span>博客 Sitemap {blogConfigCounts.sitemaps} 条 · URL 规则 {blogConfigCounts.rules} 条 · 最近识别于 {seoSummaryQuery.isLoading ? "读取中" : seoSummaryQuery.isError ? "读取失败" : lastRecognizedDate ?? "尚未记录"}</span>
      <div className="si-content-recognition-actions">
        <Link to={`/p/${id}/settings/config?section=blog-recognition`}>去设置</Link>
        {view === "blog" && <Button size="small" variant="primary" disabled={recrawlStarting || Boolean(recrawlRunId) || !project.path} onClick={() => void recrawlBlogs()}>{recrawlStarting ? "正在启动…" : recrawlRunId ? "抓取中…" : "重新抓取"}</Button>}
        {view === "blog" && recrawlProgress && <small className="si-content-recognition-progress" role="status">{recrawlProgress}</small>}
      </div>
    </div>
    {view === "blog" && blogListNotice && <p className="si-content-blog-notice" role="status">{blogListNotice}</p>}
    <div className="si-content-kpis">{summaryQuery.isLoading ? <div className="si-query-loading" role="status">正在加载内容概览…</div> : summaryQuery.isError || !summary ? <ApiErrorNotice label="内容概览加载失败。" error={summaryQuery.error} onRetry={() => void summaryQuery.refetch()} /> : summary.kpis.map((metric) => <KpiCard key={metric.key} metric={metric} />)}</div>
    <div className="si-content-toolbar si-content-toolbar-table">
      <Segmented value={view} options={viewOptions} onChange={setView} ariaLabel="内容视图" />
      <SearchInput value={(view === "blog" ? blogQuery : keywordQuery).search ?? ""} onSearch={setSearch} label="搜索内容" placeholder={view === "keywords" ? "搜索关键词或主题簇" : "搜索标题或关键词"} />
      {view === "blog" && <FilterBar className="si-content-filterbar">{blogIssues.map((item) => <FilterPill key={item.value} currentValue={blogQuery.filters?.issue ?? "all"} value={item.value} onValueChange={(value) => setBlogQuery((current) => ({ ...current, page: 1, filters: { ...current.filters, issue: !value || value === "all" ? undefined : value } }))}>{item.label}{item.value === "no_links" ? " " + issueCounts.noLinks : item.value === "no_schema" ? " " + issueCounts.noSchema : item.value === "links_oos" ? " " + issueCounts.oos : ""}</FilterPill>)}</FilterBar>}
      {view === "keywords" && <FilterBar className="si-content-filterbar">{roleOptions.map((item) => <FilterPill key={item.value} currentValue={keywordQuery.filters?.role ?? "all"} value={item.value} onValueChange={(value) => setKeywordQuery((current) => ({ ...current, page: 1, filters: { ...current.filters, role: !value || value === "all" ? undefined : value } }))}>{item.label}</FilterPill>)}{statusOptions.map((item) => <FilterPill key={item.value} currentValue={keywordQuery.filters?.status ?? "all"} value={item.value} onValueChange={(value) => setKeywordQuery((current) => ({ ...current, page: 1, filters: { ...current.filters, status: !value || value === "all" ? undefined : value } }))}>{item.label}</FilterPill>)}</FilterBar>}
      {view === "blog" && <span className="si-content-total">共 {blogs?.total ?? 0} 篇</span>}
      {view === "keywords" && <span className="si-content-total">共 {keywords?.total ?? 0} 个</span>}
    </div>
    {feedback && <p className="si-feedback" role="status">{feedback}</p>}
    <div className="si-content-table-frame">
      {activeQuery.isLoading ? <div className="si-query-loading" role="status">正在加载{view === "blog" ? "博客文章" : "关键词映射"}…</div> : activeQuery.isError ? <ApiErrorNotice label={`${view === "blog" ? "博客文章" : "关键词映射"}加载失败。`} error={activeQuery.error} onRetry={() => void activeQuery.refetch()} /> : <>
        {view === "blog" && showBlogRecognitionEmpty && blogEmptyState === "unconfigured" && <div className="si-content-blog-empty"><strong>尚未配置博客识别</strong><p>请添加博客 Sitemap 或 URL 规则，设置后系统会在 SEO 抓取中识别博客文章。</p><Link to={`/p/${id}/settings/config?section=blog-recognition`}>去设置</Link></div>}
        {view === "blog" && showBlogRecognitionEmpty && blogEmptyState === "checking" && <div className="si-content-blog-empty"><p role="status">正在确认最近一次 SEO 抓取是否使用了当前博客配置…</p></div>}
        {view === "blog" && showBlogRecognitionEmpty && blogEmptyState === "stale" && <div className="si-content-blog-empty"><strong>博客识别配置已更新，需重新抓取后才会识别。</strong><p>最近识别于 {lastRecognizedDate ?? "尚无记录"}；重新抓取会使用当前博客 Sitemap 和 URL 规则。</p><Button variant="primary" disabled={recrawlStarting || Boolean(recrawlRunId) || !project.path} onClick={() => void recrawlBlogs()}>{recrawlStarting ? "正在启动…" : recrawlRunId ? "抓取中…" : "重新抓取"}</Button>{recrawlProgress && <small role="status">{recrawlProgress}</small>}</div>}
        {view === "blog" && showBlogRecognitionEmpty && blogEmptyState === "never-crawled" && <div className="si-content-blog-empty"><strong>已配置博客识别，但尚无成功的 SEO 抓取记录。</strong><p>重新抓取后，系统会按当前博客 Sitemap 和 URL 规则识别文章。</p><Button variant="primary" disabled={recrawlStarting || Boolean(recrawlRunId) || !project.path} onClick={() => void recrawlBlogs()}>{recrawlStarting ? "正在启动…" : recrawlRunId ? "抓取中…" : "重新抓取"}</Button>{recrawlProgress && <small role="status">{recrawlProgress}</small>}</div>}
        {view === "blog" && showBlogRecognitionEmpty && blogEmptyState === "history-error" && <div className="si-content-blog-empty"><strong>已配置博客识别，但暂时无法读取最近抓取记录。</strong><p>可重新抓取以确认当前配置对应的博客数据。</p><Button variant="primary" disabled={recrawlStarting || Boolean(recrawlRunId) || !project.path} onClick={() => void recrawlBlogs()}>{recrawlStarting ? "正在启动…" : recrawlRunId ? "抓取中…" : "重新抓取"}</Button>{recrawlProgress && <small role="status">{recrawlProgress}</small>}</div>}
        {view === "blog" && showBlogRecognitionEmpty && blogEmptyState === "no-match" && <div className="si-content-blog-empty"><strong>已配置博客识别，最近抓取未发现符合规则的文章。</strong><p>最近识别于 {lastRecognizedDate ?? "尚无记录"}。</p><Button disabled={recrawlStarting || Boolean(recrawlRunId) || !project.path} onClick={() => void recrawlBlogs()}>{recrawlStarting ? "正在启动…" : recrawlRunId ? "抓取中…" : "重新抓取"}</Button>{recrawlProgress && <small role="status">{recrawlProgress}</small>}</div>}
        {view === "blog" && !showBlogRecognitionEmpty && <DataTable tableId="content.blog" rows={blogs?.rows ?? []} total={blogs?.total ?? 0} columns={blogColumnDefs} query={blogQuery} onQueryChange={setBlogQuery} onRowClick={setSelected} getRowId={(row) => row.slug} height="fill" rowHeight={52} showPagination emptyTitle="没有博客文章" emptyDescription="调整筛选条件或检查内容目录。" />}
        {view === "keywords" && <DataTable tableId="content.keywords" rows={keywords?.rows ?? []} total={keywords?.total ?? 0} columns={keywordColumnDefs} query={keywordQuery} onQueryChange={setKeywordQuery} onRowClick={setSelected} getRowId={(row) => row.keyword} height="fill" rowHeight={52} showPagination emptyTitle="没有关键词" emptyDescription="在关键词台账中添加目标关键词。" />}
      </>}
    </div>
    <p className="si-content-data-note">数据：<code>index/content/blog_index.jsonl</code> · <code>index/content/keywords.jsonl</code> · 灰色列为 GSC / 关键词工具预留位</p>
    <DetailPanel open={Boolean(selected)} onClose={() => setSelected(null)} title={selected && "title" in selected ? selected.title : selected && "keyword" in selected ? selected.keyword : "内容详情"}>
      {selected && "title" in selected && <div className="si-content-detail"><div><span>Slug</span><code>{selected.slug}</code></div><div><span>发布日期</span><code>{selected.published_at}</code></div><div><span>类别</span>{selected.category || "—"}</div><div><span>字数</span>{selected.word_count ?? "未统计"}</div><div><span>主关键词</span>{selected.primary_keyword || "未登记"}</div><div><span>内链</span>{selected.links_internal.length} 出 / {selected.links_in ?? 0} 入</div><div><span>链接产品</span>{selected.links_products.join("、") || "无"}</div><div><span>缺货产品</span>{selected.linked_out_of_stock?.join("、") || "无"}</div><div><span>Schema</span>{selected.has_faq ? "BlogPosting / FAQ" : "缺失"}</div><div className="full"><span>Meta description</span>{selected.meta_description || "缺失"}</div><Button size="small" onClick={() => void api.shell.openExternal(selected.url)}><ExternalLink size={13} />打开文章</Button></div>}
      {selected && "keyword" in selected && <div className="si-content-detail"><div><span>类型</span>{selected.role === "primary" ? "主词" : "次词"}</div><div><span>搜索意图</span>{intentLabels[selected.intent]}</div><div><span>主题簇</span>{selected.cluster}</div><div><span>状态</span>{keywordStatusLabels[selected.status]}</div><div><span>目标页面</span><code>{selected.target_url || "未分配"}</code></div><div><span>搜索量</span>{selected.search_volume ?? "预留"}</div><div><span>当前排名</span>{selected.current_rank ?? "预留"}</div><div className="full"><span>备注</span>{selected.note || "—"}</div>{selected.target_url && <Button size="small" onClick={() => void api.shell.openExternal(selected.target_url!)}><ExternalLink size={13} />打开目标页面</Button>}</div>}
    </DetailPanel>
    </ProjectTabPanel>
  </div>;
}
import "./content/page.css";
