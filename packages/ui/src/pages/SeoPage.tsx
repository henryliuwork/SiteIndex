import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { AlertTriangle, ExternalLink, FileDown, Globe2, MoreHorizontal, RefreshCw, Settings2 } from "lucide-react";
import { useParams, useSearchParams } from "react-router-dom";
import { SEO_RULE_LABELS, gradeDescriptionLength, gradeTitleLength } from "@siteindex/shared";
import type {
  JobProgress, JobResult, ListQuery, PageType, SeoIssue, SeoIssueFilters, SeoLink,
  SeoPage as SeoRecord, SeoPageFilters, SeoRuleSetting, Severity,
} from "@siteindex/shared";
import { api, apiErrorMessage } from "../api";
import { projectQueryKeys } from "../project-queries";
import { ApiErrorNotice, Button, Chip, DataTable, Drawer, EmptyState, FilterBar, KpiCard, LengthBadge, Notice, PageHeader, ProjectHeader, ProjectTabPanel, SearchInput, Segmented, useToast } from "../components";
import { SeoFilterChip, SeoMultiFilter, SeoSingleFilter } from "./seo/filters";
import { searchTextFromSearchParams, seoRouteFiltersFromSearchParams, updateSeoSearchParams, type SeoSearchParamPatch, type SeoView } from "./seo/query-params";

const pageTypes: { value: PageType | "all"; label: string }[] = [
  { value: "all", label: "全部" }, { value: "home", label: "首页" }, { value: "collection", label: "分类" },
  { value: "product", label: "产品" }, { value: "blog", label: "博客" }, { value: "page", label: "页面" }, { value: "other", label: "其他" },
];
const severityOptions: { value: Severity | "all"; label: string }[] = [
  { value: "all", label: "全部" }, { value: "high", label: "高" }, { value: "mid", label: "中" }, { value: "low", label: "低" },
];
const pageTypeLabels: Record<PageType, string> = { home: "首页", collection: "分类", product: "产品", blog: "博客", page: "页面", other: "其他" };
const issueLabels: Record<string, string> = SEO_RULE_LABELS;
const severityLabels: Record<Severity, string> = { high: "高", mid: "中", low: "低" };
const severityTones: Record<Severity, "danger" | "warn" | "neutral"> = { high: "danger", mid: "warn", low: "neutral" };
const statusLabels: Record<SeoIssue["status"], string> = { open: "待处理", fixed: "已处理", ignored: "已忽略" };
const statusTones: Record<SeoIssue["status"], "warn" | "ok" | "neutral"> = { open: "warn", fixed: "ok", ignored: "neutral" };
const initialIssueQuery: ListQuery<SeoIssueFilters> = { page: 1, pageSize: 50, filters: {} };
const initialPageQuery: ListQuery<SeoPageFilters> = { page: 1, pageSize: 50, filters: {} };
const initialLinkQuery: ListQuery = { page: 1, pageSize: 50, filters: {} };

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

interface IssueActionHandlers {
  markFixed?: (issue: SeoIssue) => void;
  ignoreIssue?: (issue: SeoIssue) => void;
  ignoreRule?: (issue: SeoIssue) => void;
  restore?: (issue: SeoIssue) => void;
}

function IssueActionMenu({ issue, handlers }: { issue: SeoIssue; handlers: IssueActionHandlers }) {
  const label = issueLabels[issue.rule] ?? issue.rule;
  const [open, setOpen] = useState(false);
  const menuItems = (issue.status === "open" ? [
    handlers.markFixed && { label: "标记已处理", action: handlers.markFixed },
    handlers.ignoreIssue && { label: "忽略此页面此问题", action: handlers.ignoreIssue },
    handlers.ignoreRule && { label: "忽略此类问题", action: handlers.ignoreRule },
  ] : [handlers.restore && { label: "恢复为待处理", action: handlers.restore }])
    .filter((item): item is { label: string; action: (issue: SeoIssue) => void } => Boolean(item));
  if (!menuItems.length) return null;

  return <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
    <PopoverPrimitive.Trigger asChild>
      <Button variant="ghost" size="small" className="si-seo-row-action" aria-label={`问题操作：${label}`} title="问题操作" onClick={(event) => event.stopPropagation()}>
        <MoreHorizontal size={16} aria-hidden="true" />
      </Button>
    </PopoverPrimitive.Trigger>
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content className="si-seo-issue-menu" role="menu" aria-label={`问题操作：${label}`} align="end" sideOffset={4} onClick={(event) => event.stopPropagation()}>
        {menuItems.map(({ label: itemLabel, action }) => <button key={itemLabel} type="button" role="menuitem" onClick={() => { setOpen(false); action(issue); }}>{itemLabel}</button>)}
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  </PopoverPrimitive.Root>;
}

function issueColumns(actions?: IssueActionHandlers): ColumnDef<SeoIssue, unknown>[] {
  const columns: ColumnDef<SeoIssue, unknown>[] = [
    { id: "severity", accessorKey: "severity", header: "级别", meta: { width: 88, grow: 0, minWidth: 88, text: "single" }, cell: ({ row }) => <Chip tone={severityTones[row.original.severity]}>{severityLabels[row.original.severity]}</Chip>, enableSorting: true },
    { id: "url", accessorKey: "url", header: "页面", meta: { width: 320, grow: 2, minWidth: 220, text: "single" }, cell: ({ row }) => <code className="si-seo-url" title={row.original.url}>{displayPath(row.original.url)}</code>, enableSorting: true },
    { id: "problem", accessorKey: "detail", header: "问题", meta: { width: 220, grow: 1, minWidth: 160, text: "clamp2" }, cell: ({ row }) => <span className="si-seo-issue-cell"><strong>{issueLabels[row.original.rule] ?? row.original.rule}</strong><span title={row.original.detail}>{row.original.detail}</span></span>, enableSorting: false },
    { id: "last_seen", accessorKey: "last_seen", header: "发现于", meta: { width: 100, grow: 0, minWidth: 92, text: "single" }, cell: ({ row }) => <code className="si-seo-date">{row.original.last_seen.slice(5)}</code>, enableSorting: true },
    { id: "status", accessorKey: "status", header: "状态", meta: { width: 88, grow: 0, minWidth: 88, text: "single" }, cell: ({ row }) => <Chip tone={statusTones[row.original.status]}>{statusLabels[row.original.status]}</Chip>, enableSorting: true },
  ];
  if (actions && Object.values(actions).some(Boolean)) columns.push({
    id: "actions", header: "操作", meta: { width: 68, grow: 0, minWidth: 68, text: "single", sticky: "right" },
    cell: ({ row }) => <IssueActionMenu issue={row.original} handlers={actions} />,
    enableSorting: false,
  });
  return columns;
}

function pageColumns(titleRange: [number, number], descriptionRange: [number, number]): ColumnDef<SeoRecord, unknown>[] {
  return [
    { id: "url", accessorKey: "url", header: "页面", meta: { width: 320, grow: 2, minWidth: 220, text: "single" }, cell: ({ row }) => <span className="si-seo-page-cell"><code>{displayPath(row.original.url)}</code><span>{row.original.title || "无 Title"}</span></span>, enableSorting: true },
    { id: "page_type", accessorKey: "page_type", header: "类型", meta: { width: 88, grow: 0, minWidth: 88, text: "single" }, cell: ({ row }) => <Chip tone="neutral">{pageTypeLabels[row.original.page_type]}</Chip>, enableSorting: true },
    { id: "title_length", accessorKey: "title_length", header: "Title 长度", meta: { width: 96, grow: 0, minWidth: 80, align: "end", text: "single" }, cell: ({ row }) => <span className="si-seo-length-cell">{row.original.title_length}<LengthBadge length={row.original.title_length} kind="title" range={titleRange} /></span>, enableSorting: true },
    { id: "description_length", accessorKey: "description_length", header: "Description 长度", meta: { width: 96, grow: 0, minWidth: 80, align: "end", text: "single" }, cell: ({ row }) => <span className="si-seo-length-cell">{row.original.description_length}<LengthBadge length={row.original.description_length} kind="description" range={descriptionRange} /></span>, enableSorting: true },
    { id: "google_indexed", accessorKey: "google_indexed", header: "收录", meta: { width: 88, grow: 0, minWidth: 88, text: "single" }, cell: ({ row }) => <Chip tone={row.original.google_indexed === true ? "ok" : row.original.google_indexed === false ? "danger" : "neutral"}>{row.original.google_indexed === true ? "已收录" : row.original.google_indexed === false ? "未收录" : "未检查"}</Chip>, enableSorting: true },
  ];
}

function linkColumns(): ColumnDef<SeoLink, unknown>[] {
  return [
    { id: "from", accessorKey: "from", header: "来源页面", meta: { width: 320, grow: 2, minWidth: 220, text: "single" }, cell: ({ row }) => <code className="si-seo-url">{displayPath(row.original.from)}</code>, enableSorting: true },
    { id: "anchor", accessorKey: "anchor", header: "锚文本", meta: { width: 220, grow: 1, minWidth: 160, text: "clamp2" }, cell: ({ row }) => row.original.anchor || "（空锚文本）", enableSorting: true },
    { id: "to", accessorKey: "to", header: "目标页面", meta: { width: 320, grow: 2, minWidth: 220, text: "single" }, cell: ({ row }) => <span className="si-seo-link-target"><code>{displayPath(row.original.to)}</code>{row.original.nofollow && <Chip tone="warn">nofollow</Chip>}</span>, enableSorting: true },
    { id: "to_type", accessorKey: "to_type", header: "类型", meta: { width: 88, grow: 0, minWidth: 88, text: "single" }, cell: ({ row }) => <Chip tone="neutral">{pageTypeLabels[row.original.to_type === "page" ? "page" : row.original.to_type]}</Chip>, enableSorting: true },
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
  const { id = "demo" } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const initialRouteFilters = seoRouteFiltersFromSearchParams(searchParams);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [view, setView] = useState<SeoView>(() => initialRouteFilters.view);
  const [issueQuery, setIssueQuery] = useState<ListQuery<SeoIssueFilters>>(() => ({ ...initialIssueQuery, filters: initialRouteFilters.issues, search: searchTextFromSearchParams(searchParams) || undefined }));
  const [pageQuery, setPageQuery] = useState<ListQuery<SeoPageFilters>>(() => ({ ...initialPageQuery, filters: initialRouteFilters.pages, search: searchTextFromSearchParams(searchParams) || undefined }));
  const [linkQuery, setLinkQuery] = useState<ListQuery>(() => ({ ...initialLinkQuery, search: searchTextFromSearchParams(searchParams) || undefined }));
  const [selectedUrl, setSelectedUrl] = useState<string | null>(null);
  const [selectedLink, setSelectedLink] = useState<SeoLink | null>(null);
  const [selectedIssues, setSelectedIssues] = useState<SeoIssue[]>([]);
  const [selectionReset, setSelectionReset] = useState(0);
  const [ruleSettingsOpen, setRuleSettingsOpen] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [runKind, setRunKind] = useState<"crawl" | "index-check" | null>(null);
  const [progressText, setProgressText] = useState("");
  const [progressPct, setProgressPct] = useState<number | null>(null);
  const projectQuery = useQuery({ queryKey: projectQueryKeys.detail(id), queryFn: () => api.projects.get(id) });
  const summaryQuery = useQuery({ queryKey: ["seo", "summary", id], queryFn: () => api.seo.summary(id) });
  const issuesQuery = useQuery({ queryKey: ["seo", "issues", id, issueQuery], queryFn: () => api.seo.listIssues(id, issueQuery) });
  const pagesQuery = useQuery({ queryKey: ["seo", "pages", id, pageQuery], queryFn: () => api.seo.listPages(id, pageQuery) });
  const linksQuery = useQuery({ queryKey: ["seo", "links", id, linkQuery], queryFn: () => api.seo.listLinks(id, linkQuery) });
  const orphansQuery = useQuery({ queryKey: ["seo", "orphans", id], queryFn: () => api.seo.orphanPages(id) });
  const detailQuery = useQuery({ queryKey: ["seo", "page", id, selectedUrl], queryFn: () => api.seo.getPage(id, selectedUrl ?? ""), enabled: Boolean(selectedUrl) });
  const getRuleSettings = api.seo.getRuleSettings;
  const ruleSettingsQuery = useQuery({
    queryKey: ["seo", "rule-settings", id],
    queryFn: () => getRuleSettings ? getRuleSettings(id) : Promise.reject(new Error("当前桌面版本暂不支持 SEO 规则设置。")),
    enabled: ruleSettingsOpen && Boolean(getRuleSettings),
  });
  const summary = summaryQuery.data;
  const project = projectQuery.data?.summary;
  const titleRange = summary?.title_range ?? [30, 60];
  const descriptionRange = summary?.description_range ?? [120, 160];
  const issueList = issuesQuery.data;
  const pageList = pagesQuery.data;
  const linkList = linksQuery.data;
  const pageColumnDefs = useMemo(() => pageColumns(titleRange, descriptionRange), [titleRange, descriptionRange]);
  const linkColumnDefs = useMemo(linkColumns, []);
  const views = [
    { value: "issues" as const, label: "问题 " + (issueList?.total ?? 0) },
    { value: "pages" as const, label: "页面 " + (pageList?.total ?? 0) },
    { value: "links" as const, label: "内链" },
  ];
  const activeListQuery = view === "issues" ? issuesQuery : view === "pages" ? pagesQuery : linksQuery;
  const busy = Boolean(activeRunId || runKind);
  const ruleFilters = useMemo(() => {
    const counts = new Map<string, { rule: string; label: string; count: number }>();
    if (summary?.issue_counts?.length) {
      for (const item of summary.issue_counts) {
        const current = counts.get(item.rule);
        counts.set(item.rule, {
          rule: item.rule,
          label: item.label || issueLabels[item.rule] || item.rule,
          count: (current?.count ?? 0) + item.count,
        });
      }
    } else {
      for (const issue of issueList?.rows ?? []) {
        const current = counts.get(issue.rule);
        counts.set(issue.rule, {
          rule: issue.rule,
          label: issueLabels[issue.rule] ?? issue.rule,
          count: (current?.count ?? 0) + 1,
        });
      }
    }
    return [...counts.values()].sort((left, right) => right.count - left.count || left.label.localeCompare(right.label, "zh-CN"));
  }, [issueList?.rows, summary?.issue_counts]);
  const selectedRules = issueQuery.filters?.rules ?? [];
  const filteredIssueCount = issueList?.total ?? 0;
  const setIssueStatus = api.seo.setIssueStatus;
  const setRuleIgnored = api.seo.setRuleIgnored;
  const selectionScope = JSON.stringify({ page: issueQuery.page, search: issueQuery.search, filters: issueQuery.filters, sort: issueQuery.sort });
  const writeSearchParams = (patch: SeoSearchParamPatch) => setSearchParams((current) => updateSeoSearchParams(current, patch), { replace: true });

  const refreshIssueData = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["seo", "summary", id] }),
      queryClient.invalidateQueries({ queryKey: ["seo", "issues", id] }),
      queryClient.invalidateQueries({ queryKey: ["seo", "rule-settings", id] }),
      queryClient.invalidateQueries({ queryKey: ["overview", id] }),
    ]);
  }, [id, queryClient]);

  const updateIssueStatus = useCallback(async (
    targets: { url: string; rule: SeoIssue["rule"] }[],
    status: SeoIssue["status"],
    confirmation: string,
  ) => {
    if (!setIssueStatus || !window.confirm(confirmation)) return;
    try {
      const result = await setIssueStatus(id, { targets, status });
      await refreshIssueData();
      toast.success(`已更新 ${result.updated} 条`);
      setSelectedIssues([]);
      setSelectionReset((value) => value + 1);
    } catch (cause) { toast.error(apiErrorMessage(cause, "SEO 问题更新失败。")); }
  }, [id, refreshIssueData, setIssueStatus, toast]);

  const ignoreIssueRule = useCallback(async (rule: SeoIssue["rule"], ignored: boolean) => {
    const label = issueLabels[rule] ?? rule;
    if (!setRuleIgnored || !window.confirm(`${ignored ? "忽略" : "恢复"}“${label}”规则？\n影响范围：全站同一规则。`)) return;
    try {
      const result = await setRuleIgnored(id, rule, ignored);
      await refreshIssueData();
      toast.success(`已更新 ${result.updated} 条`);
    } catch (cause) { toast.error(apiErrorMessage(cause, "SEO 规则设置失败。")); }
  }, [id, refreshIssueData, setRuleIgnored, toast]);

  const issueActionHandlers = useMemo<IssueActionHandlers>(() => ({
    ...(setIssueStatus ? {
      markFixed: (issue: SeoIssue) => void updateIssueStatus(
        [{ url: issue.url, rule: issue.rule }], "fixed",
        `将“${issueLabels[issue.rule] ?? issue.rule}”标记为已处理？\n影响范围：单条 SEO 问题（${displayPath(issue.url)}）。`,
      ),
      ignoreIssue: (issue: SeoIssue) => void updateIssueStatus(
        [{ url: issue.url, rule: issue.rule }], "ignored",
        `忽略此页面此问题？\n影响范围：此页面的这条 SEO 问题（${displayPath(issue.url)}）。`,
      ),
      restore: (issue: SeoIssue) => void updateIssueStatus(
        [{ url: issue.url, rule: issue.rule }], "open",
        `恢复“${issueLabels[issue.rule] ?? issue.rule}”问题？\n影响范围：单条 SEO 问题（${displayPath(issue.url)}）。`,
      ),
    } : {}),
    ...(setRuleIgnored ? { ignoreRule: (issue: SeoIssue) => void ignoreIssueRule(issue.rule, true) } : {}),
  }), [ignoreIssueRule, setIssueStatus, setRuleIgnored, updateIssueStatus]);
  const issueColumnDefs = useMemo(() => issueColumns(issueActionHandlers), [issueActionHandlers]);

  useEffect(() => {
    const routeFilters = seoRouteFiltersFromSearchParams(searchParams);
    const search = searchTextFromSearchParams(searchParams) || undefined;
    setView(routeFilters.view);
    setIssueQuery({ ...initialIssueQuery, filters: routeFilters.issues, search });
    setPageQuery({ ...initialPageQuery, filters: routeFilters.pages, search });
    setLinkQuery({ ...initialLinkQuery, search });
  }, [id, searchParams]);

  useEffect(() => {
    setSelectedIssues([]);
    setSelectionReset((value) => value + 1);
  }, [selectionScope]);

  useEffect(() => {
    setSelectedUrl(null); setSelectedLink(null); setSelectedIssues([]);
  }, [id]);

  const setStatusFilter = (value: "all" | SeoIssue["status"]) => {
    const status = value === "all" ? undefined : value;
    setIssueQuery((current) => ({ ...current, page: 1, filters: { ...current.filters, status } }));
    writeSearchParams({ status: status ?? null });
  };

  const handleBulkResolve = async () => {
    if (!setIssueStatus || issueQuery.filters?.status !== "open" || filteredIssueCount === 0) return;
    if (!window.confirm(`将当前筛选结果中的 ${filteredIssueCount} 条待处理 SEO 问题标记为已处理？\n影响范围：当前筛选命中的所有页面。`)) return;
    try {
      const result = await api.seo.listIssues(id, { ...issueQuery, page: 1, pageSize: 0 });
      const updated = await setIssueStatus(id, {
        targets: result.rows.map(({ url, rule }) => ({ url, rule })),
        status: "fixed",
      });
      await refreshIssueData();
      toast.success(`已更新 ${updated.updated} 条`);
    } catch (cause) { toast.error(apiErrorMessage(cause, "批量处理 SEO 问题失败。")); }
  };

  const handleSelectedIssues = async (status: "fixed" | "ignored") => {
    if (!setIssueStatus || selectedIssues.length === 0) return;
    const count = selectedIssues.length;
    const action = status === "fixed" ? "标记为已处理" : "忽略";
    if (!window.confirm(`将已选择的 ${count} 条 SEO 问题${action}？\n影响范围：所选问题。`)) return;
    try {
      const result = await setIssueStatus(id, {
        targets: selectedIssues.map(({ url, rule }) => ({ url, rule })),
        status,
      });
      await refreshIssueData();
      toast.success(`已更新 ${result.updated} 条`);
      setSelectedIssues([]);
      setSelectionReset((value) => value + 1);
    } catch (cause) { toast.error(apiErrorMessage(cause, "批量处理 SEO 问题失败。")); }
  };

  useEffect(() => {
    if (!activeRunId) return;
    const unsubscribeProgress = api.jobs.onProgress((progress: JobProgress) => {
      if (progress.runId !== activeRunId) return;
      setProgressText(progress.message); setProgressPct(progress.pct);
    });
    const unsubscribeFinished = api.jobs.onFinished((result: JobResult) => {
      if (result.runId !== activeRunId) return;
      setActiveRunId(null); setRunKind(null); setProgressPct(null); setProgressText("");
      if (result.status === "ok") toast.success(runKind === "index-check" ? "收录检查已完成。" : "SEO 页面已重新抓取。");
      else toast.error(result.summary);
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ["seo", "summary", id] }),
        queryClient.invalidateQueries({ queryKey: ["seo", "issues", id] }),
        queryClient.invalidateQueries({ queryKey: ["seo", "rule-settings", id] }),
        queryClient.invalidateQueries({ queryKey: ["seo", "pages", id] }),
        queryClient.invalidateQueries({ queryKey: ["seo", "links", id] }),
        queryClient.invalidateQueries({ queryKey: ["seo", "orphans", id] }),
      ]);
    });
    return () => { unsubscribeProgress(); unsubscribeFinished(); };
  }, [activeRunId, id, queryClient, runKind, toast]);

  const changeView = (next: SeoView) => {
    setView(next);
    writeSearchParams({ view: next === "issues" ? null : next });
  };
  const setSearch = (search: string) => {
    writeSearchParams({ q: search || null });
    if (view === "issues") setIssueQuery((current) => ({ ...current, page: 1, search: search || undefined }));
    else if (view === "pages") setPageQuery((current) => ({ ...current, page: 1, search: search || undefined }));
    else setLinkQuery((current) => ({ ...current, page: 1, search: search || undefined }));
  };
  const setSeverity = (value: Severity | "all") => {
    const severity = value === "all" ? undefined : value;
    setIssueQuery((current) => ({ ...current, page: 1, filters: { ...current.filters, severity } }));
    writeSearchParams({ severity: severity ?? null });
  };
  const toggleRule = (rule: string) => {
    const nextRules = selectedRules.includes(rule) ? selectedRules.filter((item) => item !== rule) : [...selectedRules, rule];
    setIssueQuery((current) => ({ ...current, page: 1, filters: { ...current.filters, rules: nextRules.length ? nextRules : undefined } }));
    writeSearchParams({ rule: nextRules });
  };
  const setRules = (rules: string[]) => {
    setIssueQuery((current) => ({ ...current, page: 1, filters: { ...current.filters, rules: rules.length ? rules : undefined } }));
    writeSearchParams({ rule: rules });
  };
  const clearIssueStatus = () => {
    setIssueQuery((current) => ({ ...current, page: 1, filters: { ...current.filters, status: undefined } }));
    writeSearchParams({ status: null });
  };
  const setPageType = (value: PageType | "all") => {
    const pageType = value === "all" ? undefined : value;
    setPageQuery((current) => ({ ...current, page: 1, filters: { ...current.filters, page_type: pageType } }));
    writeSearchParams({ page_type: pageType ?? null });
  };
  const setIndexed = (value: "all" | "yes" | "no" | "unchecked") => {
    const indexed = value === "all" ? undefined : value;
    setPageQuery((current) => ({ ...current, page: 1, filters: { ...current.filters, indexed } }));
    writeSearchParams({ indexed: indexed ?? null });
  };
  const selectedConditions: { label: string; onRemove: () => void }[] = view === "issues" ? [
    ...(issueQuery.filters?.severity ? [{ label: `严重级别 · ${severityLabels[issueQuery.filters.severity]}`, onRemove: () => setSeverity("all") }] : []),
    ...(issueQuery.filters?.status ? [{ label: `状态 · ${issueQuery.filters.status === "open" ? "待处理" : issueQuery.filters.status === "fixed" ? "已处理" : "已忽略"}`, onRemove: clearIssueStatus }] : []),
    ...selectedRules.map((rule) => ({ label: `问题类型 · ${issueLabels[rule] ?? rule}`, onRemove: () => toggleRule(rule) })),
  ] : view === "pages" ? [
    ...(pageQuery.filters?.page_type ? [{ label: `页面类型 · ${pageTypeLabels[pageQuery.filters.page_type]}`, onRemove: () => setPageType("all") }] : []),
    ...(pageQuery.filters?.indexed ? [{ label: `收录状态 · ${{ yes: "已收录", no: "未收录", unchecked: "未检查" }[pageQuery.filters.indexed]}`, onRemove: () => setIndexed("all") }] : []),
  ] : [];

  const openPage = async (url: string) => {
    try { await api.shell.openExternal(url); }
    catch (cause) { toast.error(apiErrorMessage(cause, "无法打开页面。")); }
  };
  const checkSingleIndex = async (url: string) => {
    try { const searchUrl = await api.seo.googleSiteUrl(url); await api.shell.openExternal(searchUrl); }
    catch (cause) { toast.error(apiErrorMessage(cause, "无法打开 Google 收录检查。")); }
  };
  const recrawl = async () => {
    if (!project || busy) return;
    setProgressText("正在启动 SEO 页面抓取…"); setRunKind("crawl");
    try { const run = await api.jobs.run({ projectPath: project.path, job: "weekly" }); setActiveRunId(run.runId); }
    catch (cause) { setRunKind(null); setProgressText(""); toast.error(apiErrorMessage(cause, "重新抓取启动失败。")); }
  };
  const checkIndex = async () => {
    if (busy) return;
    setProgressText("正在启动收录检查…"); setRunKind("index-check");
    try { const run = await api.seo.checkIndex(id); setActiveRunId(run.runId); }
    catch (cause) { setRunKind(null); setProgressText(""); toast.error(apiErrorMessage(cause, "收录检查启动失败。")); }
  };
  const exportIssues = async () => {
    try {
      const result = await api.seo.listIssues(id, { ...issueQuery, page: 1, pageSize: 0 });
      const lines = [["级别", "页面", "问题", "说明", "状态", "首次发现", "最近发现", "处理时间"].join(",")];
      result.rows.forEach((issue) => lines.push([
        severityLabels[issue.severity], issue.url, issueLabels[issue.rule] ?? issue.rule, issue.detail, statusLabels[issue.status], issue.first_seen, issue.last_seen, issue.handled_at ?? "",
      ].map(csvCell).join(",")));
      const blob = new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = id + "-seo-issues.csv"; anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      toast.success("问题清单已导出。");
    } catch (cause) { toast.error(apiErrorMessage(cause, "问题清单导出失败。")); }
  };
  const showPageDetail = (url: string, link: SeoLink | null = null) => { setSelectedUrl(url); setSelectedLink(link); };

  if (projectQuery.isLoading) return <div className="si-page-loading" role="status">正在加载项目信息…</div>;
  if (projectQuery.isError || !project) return <ApiErrorNotice page label="项目 SEO 页面加载失败。" error={projectQuery.error} onRetry={() => void projectQuery.refetch()} />;

  return <div className="si-page si-seo-page">
    <ProjectHeader project={project} activeTab="seo" hasTabPanel status={<Chip tone="neutral">SEO 抓取：周一 03:00 · {pageList?.total ?? 0} 个页面</Chip>} />
    <ProjectTabPanel projectId={project.id} tab="seo">
      <PageHeader
        title="SEO"
        meta={<Chip tone="neutral">最近抓取：{summary?.crawled_at?.slice(5, 10) ?? "未检查"}</Chip>}
        actions={<>
          <Button variant="primary" icon={<Settings2 size={14} />} onClick={() => setRuleSettingsOpen(true)}>规则设置</Button>
          <Button disabled={busy} icon={<Globe2 size={14} />} onClick={() => void checkIndex()}>{runKind === "index-check" ? "检查中…" : "重新检查收录"}</Button>
          <Button icon={<FileDown size={14} />} onClick={() => void exportIssues()}>导出</Button>
        </>}
        overflow={[{ label: runKind === "crawl" ? "正在重新抓取…" : "重新抓取 SEO 数据", onSelect: () => void recrawl(), disabled: busy, icon: <RefreshCw size={14} /> }]}
      />
      <div className="si-seo-kpis">{summaryQuery.isLoading ? <div className="si-query-loading" role="status">正在加载 SEO 概览…</div> : summaryQuery.isError || !summary ? <ApiErrorNotice label="SEO 概览加载失败。" error={summaryQuery.error} onRetry={() => void summaryQuery.refetch()} /> : summary.kpis.map((metric) => <KpiCard key={metric.key} metric={metric} />)}</div>
      <div className="si-seo-controls" data-view={view}>
        <Segmented value={view} options={views} onChange={changeView} ariaLabel="SEO 视图" />
        {view !== "links" && <FilterBar className="si-seo-filterbar">
          {view === "issues" ? <>
            <SeoSingleFilter label="严重级别" value={issueQuery.filters?.severity ?? "all"} options={severityOptions} onChange={setSeverity} />
            <SeoSingleFilter label="状态" value={issueQuery.filters?.status ?? "all"} options={[
              { value: "all", label: "全部状态" }, { value: "open", label: "待处理" }, { value: "fixed", label: "已处理" }, { value: "ignored", label: "已忽略" },
            ]} onChange={setStatusFilter} />
            <SeoMultiFilter label="问题类型" values={selectedRules} options={ruleFilters.map(({ rule, label, count }) => ({ value: rule, label, count }))} onChange={setRules} />
            {setIssueStatus && issueQuery.filters?.status === "open" && <Button size="small" className="si-seo-bulk-resolve" disabled={filteredIssueCount === 0} onClick={() => void handleBulkResolve()}>
              批量处理当前筛选结果（{filteredIssueCount} 条）
            </Button>}
          </> : <>
            <SeoSingleFilter label="页面类型" value={pageQuery.filters?.page_type ?? "all"} options={pageTypes} onChange={setPageType} />
            <SeoSingleFilter label="收录状态" value={pageQuery.filters?.indexed ?? "all"} options={[
              { value: "all", label: "全部" }, { value: "yes", label: "已收录" }, { value: "no", label: "未收录" }, { value: "unchecked", label: "未检查" },
            ]} onChange={setIndexed} />
          </>}
        </FilterBar>}
        <SearchInput value={(view === "issues" ? issueQuery : view === "pages" ? pageQuery : linkQuery).search ?? ""} onSearch={setSearch} label="搜索 SEO 数据" placeholder="搜索页面 URL 或内容" />
      </div>
      {selectedConditions.length > 0 && <div className="si-seo-selected-filters" aria-label="已选筛选条件">
        {selectedConditions.map((condition) => <SeoFilterChip key={condition.label} label={condition.label} onRemove={condition.onRemove} />)}
      </div>}
      {progressText && <Notice className="si-seo-progress" tone="info">{progressText}{progressPct != null && ` · ${progressPct}%`}</Notice>}
      {activeListQuery.isLoading ? <div className="si-query-loading" role="status">正在加载{view === "issues" ? "问题清单" : view === "pages" ? "页面列表" : "内链列表"}…</div> : activeListQuery.isError ? <ApiErrorNotice label={`${view === "issues" ? "SEO 问题清单" : view === "pages" ? "SEO 页面列表" : "SEO 内链列表"}加载失败。`} error={activeListQuery.error} onRetry={() => void activeListQuery.refetch()} /> : <>
        {view === "issues" && <DataTable
          key={selectionReset}
          tableId="seo.issues.v2" rows={issueList?.rows ?? []} total={issueList?.total ?? 0} columns={issueColumnDefs}
          query={issueQuery} onQueryChange={setIssueQuery} onRowClick={(row) => showPageDetail(row.url)}
          getRowId={(row) => row.url + ":" + row.rule} height="fill" rowHeight={52}
          selectable={Boolean(setIssueStatus && issueQuery.filters?.status === "open")}
          onSelectionChange={setSelectedIssues}
          toolbar={selectedIssues.length > 0 ? <div className="si-seo-selection-toolbar"><span>已选择 {selectedIssues.length} 条待处理问题</span>
            <Button size="small" onClick={() => void handleSelectedIssues("fixed")}>标记已处理</Button>
            <Button size="small" onClick={() => void handleSelectedIssues("ignored")}>忽略所选</Button>
          </div> : <div className="si-seo-length-legend"><span>Title / Description 长度：</span><LengthBadge length={50} kind="title" range={titleRange} /><span>最佳</span><LengthBadge length={25} kind="title" range={titleRange} /><span>可接受</span><LengthBadge length={10} kind="title" range={titleRange} /><span>需修改</span></div>}
          emptyTitle="没有待处理问题" emptyDescription="当前筛选条件下没有 SEO 问题。"
        />}
        {view === "pages" && <DataTable tableId="seo.pages" rows={pageList?.rows ?? []} total={pageList?.total ?? 0} columns={pageColumnDefs} query={pageQuery} onQueryChange={setPageQuery} onRowClick={(row) => showPageDetail(row.url)} getRowId={(row) => row.url} height="fill" rowHeight={52} emptyTitle="没有页面数据" emptyDescription="重新抓取后会显示页面详情。" />}
        {view === "links" && <DataTable tableId="seo.links" rows={linkList?.rows ?? []} total={linkList?.total ?? 0} columns={linkColumnDefs} query={linkQuery} onQueryChange={setLinkQuery} onRowClick={(row) => showPageDetail(row.to, row)} getRowId={(row) => row.from + ":" + row.to + ":" + row.anchor} height="fill" rowHeight={52} emptyTitle="没有内链数据" emptyDescription="重新抓取后会检查站内链接。" />}
      </>}
      {view === "links" && <details className="si-seo-orphans">
        <summary><AlertTriangle size={14} />孤立页面 {orphansQuery.data?.length ?? "—"} 个</summary>
        <div className="si-seo-orphans-list">
          {orphansQuery.isLoading ? <span role="status">正在加载孤立页面…</span> : orphansQuery.isError ? <ApiErrorNotice label="孤立页面加载失败。" error={orphansQuery.error} onRetry={() => void orphansQuery.refetch()} /> : orphansQuery.data?.length ? orphansQuery.data.map((url) => <button type="button" key={url} onClick={() => showPageDetail(url)}><code>{displayPath(url)}</code><span>查看详情</span></button>) : <span>没有孤立页面。</span>}
        </div>
      </details>}
      <p className="si-seo-disclaimer">Google site: 检查结果仅供参考，以 Search Console 为准。收录数据最后检查：{summary?.crawled_at?.slice(5, 10) ?? "未检查"}。</p>
    </ProjectTabPanel>
    <Drawer open={Boolean(selectedUrl)} onOpenChange={(open) => { if (!open) { setSelectedUrl(null); setSelectedLink(null); } }} title={detailQuery.data?.title || (selectedUrl ? displayPath(selectedUrl) : "页面详情")}>
      {selectedLink && <div className="si-seo-selected-link"><strong>内链关系</strong><span>来源：{displayPath(selectedLink.from)}</span><span>锚文本：{selectedLink.anchor || "（空锚文本）"}</span><span>目标类型：{pageTypeLabels[selectedLink.to_type]}</span>{selectedLink.nofollow && <Chip tone="warn">nofollow</Chip>}</div>}
      {detailQuery.isLoading ? <div className="si-query-loading" role="status">正在加载页面详情…</div> : detailQuery.isError ? <ApiErrorNotice label="页面详情加载失败。" error={detailQuery.error} onRetry={() => void detailQuery.refetch()} /> : detailQuery.data ? <SeoDetail
        page={detailQuery.data} titleRange={titleRange} descriptionRange={descriptionRange}
        onOpen={() => void openPage(detailQuery.data!.url)} onCheckIndex={() => void checkSingleIndex(detailQuery.data!.url)}
      /> : selectedUrl ? <EmptyState>没有找到该页面的 SEO 数据。</EmptyState> : null}
    </Drawer>
    <Drawer open={ruleSettingsOpen} onOpenChange={setRuleSettingsOpen} title="SEO 规则设置" description="查看规则说明与待处理数量，并设置全站规则忽略。">
      {!getRuleSettings ? <Notice tone="warn" title="当前环境暂不支持规则设置">当前桌面版本尚未接入 seo.getRuleSettings，请更新后重试。</Notice>
        : ruleSettingsQuery.isLoading ? <div className="si-query-loading" role="status">正在加载 SEO 规则…</div>
          : ruleSettingsQuery.isError ? <ApiErrorNotice label="SEO 规则加载失败。" error={ruleSettingsQuery.error} onRetry={() => void ruleSettingsQuery.refetch()} />
            : ruleSettingsQuery.data?.length ? <div className="si-seo-rule-settings">
              {ruleSettingsQuery.data.map((setting) => <section key={setting.rule} className="si-seo-rule-setting">
                <div className="si-seo-rule-setting-heading"><div><strong>{setting.name}</strong><Chip tone={severityTones[setting.severity]}>{severityLabels[setting.severity]}</Chip></div><span>待处理 {setting.pending_count} 条</span></div>
                <p>{setting.description}</p>
                {setting.ignored_urls.length > 0 && <div className="si-seo-rule-setting-urls">
                  <strong>按页面忽略（{setting.ignored_urls.length}）</strong>
                  <ul>{setting.ignored_urls.map((url) => <li key={url}><code title={url}>{displayPath(url)}</code></li>)}</ul>
                </div>}
                {setRuleIgnored && <Button size="small" variant={setting.ignored ? "quiet" : "secondary"} onClick={() => void ignoreIssueRule(setting.rule, !setting.ignored)}>{setting.ignored ? "恢复此规则" : "忽略此规则"}</Button>}
              </section>)}
            </div> : <EmptyState title="没有 SEO 规则">当前环境没有返回规则设置。</EmptyState>}
    </Drawer>
  </div>;
}
import "./seo/page.css";
