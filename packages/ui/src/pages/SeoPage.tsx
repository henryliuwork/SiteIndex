import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { AlertTriangle, ExternalLink, FileDown, Globe2, RefreshCw } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import { gradeDescriptionLength, gradeTitleLength } from "@siteindex/shared";
import type {
  JobProgress, JobResult, ListQuery, PageType, ProjectDetail, SeoIssue, SeoIssueFilters, SeoLink,
  SeoPage as SeoRecord, SeoPageFilters, SeoRule, Severity,
} from "@siteindex/shared";
import { api, apiErrorMessage } from "../api";
import { ApiErrorNotice, Button, Chip, DataTable, DetailPanel, FilterPill, KpiCard, LengthBadge, SearchInput, Segmented, Tabs } from "../components";

type SeoView = "issues" | "pages" | "links";
const projectTabs = [
  { value: "overview", label: "概览" }, { value: "inventory", label: "库存" },
  { value: "products", label: "产品" }, { value: "seo", label: "SEO" },
  { value: "content", label: "内容" }, { value: "edm", label: "EDM" },
  { value: "design", label: "设计" }, { value: "readme", label: "README" },
  { value: "runs", label: "运行" }, { value: "settings", label: "设置" },
] as const;
const pageTypes: { value: PageType | "all"; label: string }[] = [
  { value: "all", label: "全部" }, { value: "home", label: "首页" }, { value: "collection", label: "分类" },
  { value: "product", label: "产品" }, { value: "blog", label: "博客" }, { value: "page", label: "页面" }, { value: "other", label: "其他" },
];
const severityOptions: { value: Severity | "all"; label: string }[] = [
  { value: "all", label: "全部" }, { value: "high", label: "高" }, { value: "mid", label: "中" }, { value: "low", label: "低" },
];
const pageTypeLabels: Record<PageType, string> = { home: "首页", collection: "分类", product: "产品", blog: "博客", page: "页面", other: "其他" };
const issueLabels: Record<SeoRule, string> = {
  http_4xx: "页面 4xx", http_5xx: "页面 5xx", redirect_chain: "重定向链", noindex: "noindex",
  canonical_other: "Canonical 指向其他页面", canonical_missing: "Canonical 缺失", not_in_sitemap: "未在 Sitemap 中",
  title_missing: "Title 缺失", desc_missing: "Meta description 缺失", title_length: "Title 长度异常",
  desc_length: "Description 长度异常", title_duplicate: "Title 重复", desc_duplicate: "Description 重复",
  h1_missing: "H1 缺失", h1_multiple: "H1 多个", schema_missing: "Schema 缺失", schema_error: "Schema 错误",
  img_alt_missing: "图片 Alt 缺失", thin_content: "内容过短", orphan: "孤立页面",
};
const severityLabels: Record<Severity, string> = { high: "高", mid: "中", low: "低" };
const severityTones: Record<Severity, "danger" | "warn" | "neutral"> = { high: "danger", mid: "warn", low: "neutral" };
const initialIssueQuery: ListQuery<SeoIssueFilters> = { page: 1, pageSize: 100, filters: {} };
const initialPageQuery: ListQuery<SeoPageFilters> = { page: 1, pageSize: 100, filters: {} };
const initialLinkQuery: ListQuery = { page: 1, pageSize: 100, filters: {} };
const platformNames: Record<ProjectDetail["summary"]["platform"], string> = {
  magento: "Magento", wordpress: "WordPress", woocommerce: "WooCommerce", shopify: "Shopify", other: "其他平台",
};

function displayPath(url: string): string {
  try { const parsed = new URL(url); return parsed.pathname + parsed.search; }
  catch { return url; }
}

function gradeLabel(length: number, kind: "title" | "description", range: [number, number]): string {
  const grade = kind === "title" ? gradeTitleLength(length, range) : gradeDescriptionLength(length, range);
  return grade === "good" ? "最佳" : grade === "fair" ? "可接受" : "需修改";
}

function csvCell(value: string): string {
  return '"' + value.replaceAll('"', '""') + '"';
}

function issueColumns(): ColumnDef<SeoIssue, unknown>[] {
  return [
    { id: "severity", accessorKey: "severity", header: "级别", cell: ({ row }) => <Chip tone={severityTones[row.original.severity]}>{severityLabels[row.original.severity]}</Chip>, enableSorting: true },
    { id: "url", accessorKey: "url", header: "页面", cell: ({ row }) => <code className="si-seo-url">{displayPath(row.original.url)}</code>, enableSorting: true },
    { id: "problem", accessorKey: "detail", header: "问题", cell: ({ row }) => <span className="si-seo-issue-cell"><strong>{issueLabels[row.original.rule]}</strong><span>{row.original.detail}</span></span>, enableSorting: false },
    { id: "last_seen", accessorKey: "last_seen", header: "发现于", cell: ({ row }) => <code className="si-seo-date">{row.original.last_seen.slice(5)}</code>, enableSorting: true },
  ];
}

function pageColumns(titleRange: [number, number], descriptionRange: [number, number]): ColumnDef<SeoRecord, unknown>[] {
  return [
    { id: "url", accessorKey: "url", header: "页面", cell: ({ row }) => <span className="si-seo-page-cell"><code>{displayPath(row.original.url)}</code><span>{row.original.title || "无 Title"}</span></span>, enableSorting: true },
    { id: "page_type", accessorKey: "page_type", header: "类型", cell: ({ row }) => <Chip tone="neutral">{pageTypeLabels[row.original.page_type]}</Chip>, enableSorting: true },
    { id: "title_length", accessorKey: "title_length", header: "Title 长度", cell: ({ row }) => <span className="si-seo-length-cell">{row.original.title_length}<LengthBadge length={row.original.title_length} kind="title" range={titleRange} /></span>, enableSorting: true },
    { id: "description_length", accessorKey: "description_length", header: "Description 长度", cell: ({ row }) => <span className="si-seo-length-cell">{row.original.description_length}<LengthBadge length={row.original.description_length} kind="description" range={descriptionRange} /></span>, enableSorting: true },
    { id: "google_indexed", accessorKey: "google_indexed", header: "收录", cell: ({ row }) => <Chip tone={row.original.google_indexed === true ? "ok" : row.original.google_indexed === false ? "danger" : "neutral"}>{row.original.google_indexed === true ? "已收录" : row.original.google_indexed === false ? "未收录" : "未检查"}</Chip>, enableSorting: true },
  ];
}

function linkColumns(): ColumnDef<SeoLink, unknown>[] {
  return [
    { id: "from", accessorKey: "from", header: "来源页面", cell: ({ row }) => <code className="si-seo-url">{displayPath(row.original.from)}</code>, enableSorting: true },
    { id: "anchor", accessorKey: "anchor", header: "锚文本", cell: ({ row }) => row.original.anchor || "（空锚文本）", enableSorting: true },
    { id: "to", accessorKey: "to", header: "目标页面", cell: ({ row }) => <span className="si-seo-link-target"><code>{displayPath(row.original.to)}</code>{row.original.nofollow && <Chip tone="warn">nofollow</Chip>}</span>, enableSorting: true },
    { id: "to_type", accessorKey: "to_type", header: "类型", cell: ({ row }) => <Chip tone="neutral">{pageTypeLabels[row.original.to_type === "page" ? "page" : row.original.to_type]}</Chip>, enableSorting: true },
  ];
}

function SeoField({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="si-seo-detail-field"><span>{label}</span><div>{children || "—"}</div></div>;
}

function SeoDetail({
  page, titleRange, descriptionRange, onOpen, onCheckIndex,
}: {
  page: SeoRecord;
  titleRange: [number, number];
  descriptionRange: [number, number];
  onOpen: () => void;
  onCheckIndex: () => void;
}) {
  const schemaTypes = page.schema_types.length ? page.schema_types : [];
  return <div className="si-seo-detail">
    <div className="si-seo-detail-actions"><Button size="small" onClick={onOpen}><ExternalLink size={13} />打开页面</Button><Button size="small" onClick={onCheckIndex}><Globe2 size={13} />检查收录</Button></div>
    <section>
      <h4>Index</h4>
      <div className="si-seo-detail-grid">
        <SeoField label="Google 收录"><Chip tone={page.google_indexed === true ? "ok" : page.google_indexed === false ? "danger" : "neutral"}>{page.google_indexed === true ? "已收录" : page.google_indexed === false ? "未收录" : "未检查"}</Chip></SeoField>
        <SeoField label="可索引"><Chip tone={page.indexable ? "ok" : "warn"}>{page.indexable ? "是" : "否"}</Chip></SeoField>
        <SeoField label="检查日期">{page.index_checked_at || "未检查"}</SeoField>
        <SeoField label="HTTP 状态">{page.status_code}{page.response_ms != null && " · " + page.response_ms + " ms"}</SeoField>
        <SeoField label="Sitemap"><Chip tone={page.in_sitemap ? "ok" : "neutral"}>{page.in_sitemap ? "是" : "否"}</Chip></SeoField>
        <SeoField label="最近抓取">{page.last_crawled}</SeoField>
      </div>
    </section>
    <section>
      <h4>页面元数据</h4>
      <SeoField label="Title"><span className="si-seo-detail-length">{page.title || "—"}<LengthBadge length={page.title_length} kind="title" range={titleRange} /><small>{gradeLabel(page.title_length, "title", titleRange)}</small></span></SeoField>
      <SeoField label="Description"><span className="si-seo-detail-length">{page.meta_description || "—"}<LengthBadge length={page.description_length} kind="description" range={descriptionRange} /><small>{gradeLabel(page.description_length, "description", descriptionRange)}</small></span></SeoField>
      <SeoField label="Keywords">{page.meta_keywords}</SeoField>
      <SeoField label="H1">{page.h1}{page.h1_count > 1 && <Chip tone="warn">{page.h1_count} 个</Chip>}</SeoField>
      <SeoField label="H2">{page.h2?.join(" · ")}</SeoField>
      <SeoField label="Canonical"><span>{page.canonical || "缺失"} <Chip tone={page.canonical_status === "self" ? "ok" : page.canonical_status === "other" ? "warn" : "danger"}>{page.canonical_status === "self" ? "自身" : page.canonical_status === "other" ? "其他页面" : "缺失"}</Chip></span></SeoField>
      <SeoField label="Meta robots">{page.robots_meta || "默认"}</SeoField>
      <SeoField label="X-Robots-Tag">{page.x_robots_tag}</SeoField>
      <SeoField label="hreflang">{page.hreflang?.length ? page.hreflang.map((item) => item.lang + " → " + displayPath(item.url)).join(" · ") : "无"}</SeoField>
      <SeoField label="Open Graph">{[page.og?.title, page.og?.description, page.og?.image].filter(Boolean).join(" · ")}</SeoField>
      <SeoField label="Twitter Card">{page.twitter_card}</SeoField>
    </section>
    <section>
      <h4>结构化数据与内容</h4>
      <SeoField label="Schema"><span className="si-seo-schema-list">{schemaTypes.length ? schemaTypes.map((schema) => <span className="si-seo-schema-pill" key={schema}>{schema}</span>) : <span className="si-muted">未检测到 Schema</span>}</span></SeoField>
      {page.schema_errors?.length ? <SeoField label="Schema 错误">{page.schema_errors.join("；")}</SeoField> : null}
      <SeoField label="字数">{page.word_count ?? "未统计"}</SeoField>
      <SeoField label="图片 Alt">{page.images_missing_alt ?? 0} / {page.images_total ?? 0} 缺失</SeoField>
      <SeoField label="站内链接出 / 入">{page.links_internal_out ?? 0} / {page.links_internal_in ?? 0}</SeoField>
      <SeoField label="外链出站">{page.links_external_out ?? 0}</SeoField>
    </section>
  </div>;
}

export function SeoPage() {
  const { id = "kingsyard" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [view, setView] = useState<SeoView>("issues");
  const [issueQuery, setIssueQuery] = useState(initialIssueQuery);
  const [pageQuery, setPageQuery] = useState(initialPageQuery);
  const [linkQuery, setLinkQuery] = useState(initialLinkQuery);
  const [selectedUrl, setSelectedUrl] = useState<string | null>(null);
  const [selectedLink, setSelectedLink] = useState<SeoLink | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [runKind, setRunKind] = useState<"crawl" | "index" | null>(null);
  const [progressText, setProgressText] = useState("");
  const [progressPct, setProgressPct] = useState<number | null>(null);
  const [feedback, setFeedback] = useState("");
  const projectQuery = useQuery({ queryKey: ["project", id], queryFn: () => api.projects.get(id) });
  const summaryQuery = useQuery({ queryKey: ["seo", "summary", id], queryFn: () => api.seo.summary(id) });
  const issuesQuery = useQuery({ queryKey: ["seo", "issues", id, issueQuery], queryFn: () => api.seo.listIssues(id, issueQuery) });
  const pagesQuery = useQuery({ queryKey: ["seo", "pages", id, pageQuery], queryFn: () => api.seo.listPages(id, pageQuery) });
  const linksQuery = useQuery({ queryKey: ["seo", "links", id, linkQuery], queryFn: () => api.seo.listLinks(id, linkQuery) });
  const orphansQuery = useQuery({ queryKey: ["seo", "orphans", id], queryFn: () => api.seo.orphanPages(id) });
  const detailQuery = useQuery({ queryKey: ["seo", "page", id, selectedUrl], queryFn: () => api.seo.getPage(id, selectedUrl ?? ""), enabled: Boolean(selectedUrl) });
  const summary = summaryQuery.data;
  const project = projectQuery.data?.summary;
  const titleRange = summary?.title_range ?? [30, 60];
  const descriptionRange = summary?.description_range ?? [120, 160];
  const issueList = issuesQuery.data;
  const pageList = pagesQuery.data;
  const linkList = linksQuery.data;
  const issueColumnDefs = useMemo(issueColumns, []);
  const pageColumnDefs = useMemo(() => pageColumns(titleRange, descriptionRange), [titleRange, descriptionRange]);
  const linkColumnDefs = useMemo(linkColumns, []);
  const views = [
    { value: "issues" as const, label: "问题 " + (issueList?.total ?? 0) },
    { value: "pages" as const, label: "页面 " + (pageList?.total ?? 0) },
    { value: "links" as const, label: "内链" },
  ];
  const activeListQuery = view === "issues" ? issuesQuery : view === "pages" ? pagesQuery : linksQuery;
  const busy = Boolean(activeRunId || runKind);

  useEffect(() => {
    setView("issues"); setIssueQuery(initialIssueQuery); setPageQuery(initialPageQuery); setLinkQuery(initialLinkQuery);
    setSelectedUrl(null); setSelectedLink(null); setFeedback("");
  }, [id]);

  useEffect(() => {
    if (!activeRunId) return;
    const unsubscribeProgress = api.jobs.onProgress((progress: JobProgress) => {
      if (progress.runId !== activeRunId) return;
      setProgressText(progress.message); setProgressPct(progress.pct);
    });
    const unsubscribeFinished = api.jobs.onFinished((result: JobResult) => {
      if (result.runId !== activeRunId) return;
      setActiveRunId(null); setRunKind(null); setProgressPct(null); setProgressText("");
      setFeedback(result.status === "ok" ? (result.job === "index-check" ? "收录检查已完成。结果仅供参考，以 Search Console 为准。" : "SEO 页面已重新抓取。") : result.summary);
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ["seo", "summary", id] }),
        queryClient.invalidateQueries({ queryKey: ["seo", "issues", id] }),
        queryClient.invalidateQueries({ queryKey: ["seo", "pages", id] }),
        queryClient.invalidateQueries({ queryKey: ["seo", "links", id] }),
        queryClient.invalidateQueries({ queryKey: ["seo", "orphans", id] }),
      ]);
    });
    return () => { unsubscribeProgress(); unsubscribeFinished(); };
  }, [activeRunId, id, queryClient]);

  const onTabChange = (tab: typeof projectTabs[number]["value"]) => navigate(tab === "settings" ? "/p/" + id + "/settings/config" : "/p/" + id + (tab === "overview" ? "" : "/" + tab));
  const setSearch = (search: string) => {
    if (view === "issues") setIssueQuery((current) => ({ ...current, page: 1, search: search || undefined }));
    else if (view === "pages") setPageQuery((current) => ({ ...current, page: 1, search: search || undefined }));
    else setLinkQuery((current) => ({ ...current, page: 1, search: search || undefined }));
  };
  const setSeverity = (value: Severity | "all" | undefined) => setIssueQuery((current) => ({ ...current, page: 1, filters: { ...current.filters, severity: !value || value === "all" ? undefined : value } }));
  const setPageType = (value: PageType | "all" | undefined) => setPageQuery((current) => ({ ...current, page: 1, filters: { ...current.filters, page_type: !value || value === "all" ? undefined : value } }));
  const setIndexed = (value: "all" | "yes" | "no" | "unchecked" | undefined) => setPageQuery((current) => ({ ...current, page: 1, filters: { ...current.filters, indexed: !value || value === "all" ? undefined : value } }));

  const openPage = async (url: string) => {
    try { await api.shell.openExternal(url); }
    catch (cause) { setFeedback(apiErrorMessage(cause, "无法打开页面。")); }
  };
  const checkSingleIndex = async (url: string) => {
    try { const searchUrl = await api.seo.googleSiteUrl(url); await api.shell.openExternal(searchUrl); }
    catch (cause) { setFeedback(apiErrorMessage(cause, "无法打开 Google 收录检查。")); }
  };
  const checkAllIndex = async () => {
    if (busy) return;
    setFeedback(""); setProgressText("正在准备收录检查…"); setRunKind("index");
    try { const run = await api.seo.checkIndex(id); setActiveRunId(run.runId); }
    catch (cause) { setRunKind(null); setProgressText(""); setFeedback(apiErrorMessage(cause, "收录检查启动失败。")); }
  };
  const recrawl = async () => {
    if (!project || busy) return;
    setFeedback(""); setProgressText("正在启动 SEO 页面抓取…"); setRunKind("crawl");
    try { const run = await api.jobs.run({ projectPath: project.path, job: "weekly" }); setActiveRunId(run.runId); }
    catch (cause) { setRunKind(null); setProgressText(""); setFeedback(apiErrorMessage(cause, "重新抓取启动失败。")); }
  };
  const exportIssues = async () => {
    setFeedback("");
    try {
      const result = await api.seo.listIssues(id, { ...issueQuery, page: 1, pageSize: 0 });
      const lines = [["级别", "页面", "问题", "说明", "状态", "首次发现", "最近发现"].join(",")];
      result.rows.forEach((issue) => lines.push([
        severityLabels[issue.severity], issue.url, issueLabels[issue.rule], issue.detail, issue.status, issue.first_seen, issue.last_seen,
      ].map(csvCell).join(",")));
      const blob = new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = id + "-seo-issues.csv"; anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setFeedback("问题清单已导出。");
    } catch (cause) { setFeedback(apiErrorMessage(cause, "问题清单导出失败。")); }
  };
  const showPageDetail = (url: string, link: SeoLink | null = null) => { setSelectedUrl(url); setSelectedLink(link); };

  if (projectQuery.isLoading) return <div className="si-page-loading" role="status">正在加载项目信息…</div>;
  if (projectQuery.isError || !project) return <ApiErrorNotice page label="项目 SEO 页面加载失败。" error={projectQuery.error} onRetry={() => void projectQuery.refetch()} />;

  return <div className="si-page si-seo-page">
    <header className="si-project-page-heading">
      <div className="si-project-title-line"><h1>{project.name}</h1><code>{project.domain} · {platformNames[project.platform]}</code><Chip tone="neutral">SEO 抓取：周一 03:00 · {pageList?.total ?? 0} 个页面</Chip></div>
      <div className="si-page-actions">
        <Button onClick={() => void exportIssues()}><FileDown size={14} />导出问题清单</Button>
        <Button variant="primary" icon={<RefreshCw size={14} />} disabled={busy || !project.path} onClick={() => void recrawl()}>{runKind === "crawl" ? "抓取中…" : "重新抓取"}</Button>
      </div>
    </header>
    <Tabs value="seo" options={projectTabs} ariaLabel="项目页面" onChange={onTabChange} />
    <div className="si-seo-kpis">{summaryQuery.isLoading ? <div className="si-query-loading" role="status">正在加载 SEO 概览…</div> : summaryQuery.isError || !summary ? <ApiErrorNotice label="SEO 概览加载失败。" error={summaryQuery.error} onRetry={() => void summaryQuery.refetch()} /> : summary.kpis.map((metric) => <KpiCard key={metric.key} metric={metric} />)}</div>
    <div className={`si-seo-controls${view === "issues" ? " is-issues" : ""}`}>
      <Segmented value={view} options={views} onChange={setView} ariaLabel="SEO 视图" />
      {view === "issues" && <div className="si-seo-filter-group" aria-label="按严重级别筛选">{severityOptions.map((item) => <FilterPill key={item.value} currentValue={issueQuery.filters?.severity ?? "all"} value={item.value} onValueChange={setSeverity}>{item.label}</FilterPill>)}</div>}
      {view === "pages" && <div className="si-seo-page-filters"><div>{pageTypes.map((item) => <FilterPill key={item.value} currentValue={pageQuery.filters?.page_type ?? "all"} value={item.value} onValueChange={setPageType}>{item.label}</FilterPill>)}</div><div>{[{ value: "all" as const, label: "全部收录" }, { value: "yes" as const, label: "已收录" }, { value: "no" as const, label: "未收录" }, { value: "unchecked" as const, label: "未检查" }].map((item) => <FilterPill key={item.value} currentValue={pageQuery.filters?.indexed ?? "all"} value={item.value} onValueChange={setIndexed}>{item.label}</FilterPill>)}</div></div>}
      {view === "links" && <Chip tone="warn">孤立页面 {orphansQuery.data?.length ?? 0}</Chip>}
      <SearchInput value={(view === "issues" ? issueQuery : view === "pages" ? pageQuery : linkQuery).search ?? ""} onSearch={setSearch} label="搜索 SEO 数据" placeholder="搜索页面 URL 或内容" />
      <Button disabled={busy} onClick={() => void checkAllIndex()}><Globe2 size={14} />{runKind === "index" ? "检查中…" : "检查全部收录"}</Button>
    </div>
    {progressText && <div className="si-seo-progress" role="status"><span>{progressText}</span>{progressPct != null && <strong>{progressPct}%</strong>}</div>}
    {feedback && <p className="si-feedback" role="status">{feedback}</p>}
    <div className={`si-seo-table-frame si-seo-table-${view}`}>
      {activeListQuery.isLoading ? <div className="si-query-loading" role="status">正在加载{view === "issues" ? "问题清单" : view === "pages" ? "页面列表" : "内链列表"}…</div> : activeListQuery.isError ? <ApiErrorNotice label={`${view === "issues" ? "SEO 问题清单" : view === "pages" ? "SEO 页面列表" : "SEO 内链列表"}加载失败。`} error={activeListQuery.error} onRetry={() => void activeListQuery.refetch()} /> : <>
        {view === "issues" && <DataTable tableId="seo.issues" rows={issueList?.rows ?? []} total={issueList?.total ?? 0} columns={issueColumnDefs} query={issueQuery} onQueryChange={setIssueQuery} onRowClick={(row) => showPageDetail(row.url)} getRowId={(row) => row.url + ":" + row.rule} maxHeight={405} rowHeight={52} showPagination={false} emptyTitle="没有待处理问题" emptyDescription="当前筛选条件下没有 SEO 问题。" />}
        {view === "pages" && <DataTable tableId="seo.pages" rows={pageList?.rows ?? []} total={pageList?.total ?? 0} columns={pageColumnDefs} query={pageQuery} onQueryChange={setPageQuery} onRowClick={(row) => showPageDetail(row.url)} getRowId={(row) => row.url} maxHeight={405} rowHeight={52} showPagination={false} emptyTitle="没有页面数据" emptyDescription="重新抓取后会显示页面详情。" />}
        {view === "links" && <DataTable tableId="seo.links" rows={linkList?.rows ?? []} total={linkList?.total ?? 0} columns={linkColumnDefs} query={linkQuery} onQueryChange={setLinkQuery} onRowClick={(row) => showPageDetail(row.to, row)} getRowId={(row) => row.from + ":" + row.to + ":" + row.anchor} maxHeight={405} rowHeight={52} showPagination={false} emptyTitle="没有内链数据" emptyDescription="重新抓取后会检查站内链接。" />}
        {view === "issues" && <div className="si-seo-length-legend"><span>长度：</span><LengthBadge length={50} kind="title" range={titleRange} /><span>最佳</span><LengthBadge length={25} kind="title" range={titleRange} /><span>可接受</span><LengthBadge length={10} kind="title" range={titleRange} /><span>需修改</span><span>· Title {titleRange[0]}–{titleRange[1]} · Description {descriptionRange[0]}–{descriptionRange[1]}</span></div>}
      </>}
      {view === "links" && <div className="si-seo-orphans"><strong><AlertTriangle size={14} />孤立页面</strong>{orphansQuery.isLoading ? <span role="status">正在加载孤立页面…</span> : orphansQuery.isError ? <ApiErrorNotice label="孤立页面加载失败。" error={orphansQuery.error} onRetry={() => void orphansQuery.refetch()} /> : orphansQuery.data?.length ? orphansQuery.data.map((url) => <button type="button" key={url} onClick={() => showPageDetail(url)}><code>{displayPath(url)}</code><span>查看详情</span></button>) : <span>没有孤立页面。</span>}</div>}
    </div>
    <p className="si-seo-disclaimer">Google site: 检查结果仅供参考，以 Search Console 为准。收录数据最后检查：{summary?.crawled_at?.slice(5, 10) ?? "未检查"}。</p>
    <DetailPanel open={Boolean(selectedUrl)} onClose={() => { setSelectedUrl(null); setSelectedLink(null); }} title={detailQuery.data?.title || (selectedUrl ? displayPath(selectedUrl) : "页面详情")}>
      {selectedLink && <div className="si-seo-selected-link"><strong>内链关系</strong><span>来源：{displayPath(selectedLink.from)}</span><span>锚文本：{selectedLink.anchor || "（空锚文本）"}</span><span>目标类型：{pageTypeLabels[selectedLink.to_type]}</span>{selectedLink.nofollow && <Chip tone="warn">nofollow</Chip>}</div>}
      {detailQuery.isLoading ? <div className="si-query-loading" role="status">正在加载页面详情…</div> : detailQuery.isError ? <ApiErrorNotice label="页面详情加载失败。" error={detailQuery.error} onRetry={() => void detailQuery.refetch()} /> : detailQuery.data ? <SeoDetail
        page={detailQuery.data} titleRange={titleRange} descriptionRange={descriptionRange}
        onOpen={() => void openPage(detailQuery.data!.url)} onCheckIndex={() => void checkSingleIndex(detailQuery.data!.url)}
      /> : <div className="si-empty-state">没有找到该页面的 SEO 数据。</div>}
    </DetailPanel>
  </div>;
}
import "./seo/page.css";
