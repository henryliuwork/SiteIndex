import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { Copy, ExternalLink, Image as ImageIcon } from "lucide-react";
import { useParams } from "react-router-dom";
import type { EdmCommandInput, Kpi, ListQuery, SkuImageFilters, SkuImageRow, StockStatus } from "@siteindex/shared";
import { api, apiErrorMessage, isMockApi } from "../api";
import { projectQueryKeys } from "../project-queries";
import { ApiErrorNotice, Button, Chip, DataTable, DetailPanel, FilterPill, KpiCard, ProjectHeader, ProjectTabPanel, SearchInput, stockTone } from "../components";

type ImageView = NonNullable<SkuImageFilters["view"]> | "all";
const stockLabels: Record<StockStatus, string> = { in_stock: "有货", out_of_stock: "缺货", preorder: "预售", unknown: "未知" };
const viewOptions: { value: ImageView; label: string }[] = [
  { value: "all", label: "全部" }, { value: "in_stock", label: "有货" }, { value: "no_feed", label: "未抓取到首图" },
  { value: "has_manual", label: "已填手动图" }, { value: "none", label: "缺图" },
];

function ImageThumbnail({ src, label }: { src: string | null; label: string }) {
  const [failed, setFailed] = useState(false);
  const canLoad = Boolean(src) && (!isMockApi || src?.startsWith("data:image/"));
  useEffect(() => setFailed(false), [src]);
  return canLoad && src && !failed
    ? <img className="si-edm-thumbnail" src={src} alt={label} loading="lazy" onError={() => setFailed(true)} />
    : <span className="si-edm-thumbnail-empty" role="img" aria-label={label}><ImageIcon size={16} /><small>{src ? "图片" : "无图片"}</small></span>;
}

function ManualImageCell({ projectId, row }: { projectId: string; row: SkuImageRow }) {
  const queryClient = useQueryClient();
  const [url, setUrl] = useState(row.manual_image_url ?? "");
  const [saved, setSaved] = useState(false);
  useEffect(() => { setUrl(row.manual_image_url ?? ""); setSaved(false); }, [row.manual_image_url]);
  const mutation = useMutation({
    mutationFn: () => api.edm.setManualImage(projectId, row.sku, url.trim() || null),
    onSuccess: async () => {
      setSaved(true);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["edm", "images", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["edm", "summary", projectId] }),
      ]);
    },
  });
  return <div className="si-edm-manual-cell">
    <input type="url" aria-label={row.sku + " 手动首图地址"} value={url} placeholder="粘贴 Mailchimp 等图片地址" onChange={(event) => { setUrl(event.target.value); setSaved(false); }} />
    <Button size="small" disabled={mutation.isPending} onClick={() => void mutation.mutateAsync().catch(() => undefined)}>{mutation.isPending ? "保存中" : "保存"}</Button>
    {saved && <span className="si-edm-save-status" role="status">已保存</span>}
    {mutation.isError && <span className="si-edm-error" role="alert">{apiErrorMessage(mutation.error, "保存失败")}</span>}
  </div>;
}

function feedImageLabel(url: string | null): string {
  if (!url) return "未抓取到首图";
  try { return new URL(url).pathname; } catch { return url; }
}

function imageColumns(projectId: string): ColumnDef<SkuImageRow, unknown>[] {
  return [
    { id: "sku", accessorKey: "sku", header: "SKU", cell: ({ row }) => <code className="si-edm-sku">{row.original.sku}</code>, enableSorting: true },
    { id: "product", accessorKey: "title", header: "产品 / 变体", cell: ({ row }) => <span className="si-edm-product"><strong>{row.original.title}</strong><small>{row.original.variant_title || "默认款"}</small></span>, enableSorting: true },
    { id: "stock_status", accessorKey: "stock_status", header: "库存", cell: ({ row }) => <Chip tone={stockTone[row.original.stock_status]}>{stockLabels[row.original.stock_status]}</Chip>, enableSorting: true },
    { id: "feed_image_url", accessorKey: "feed_image_url", header: "抓取到的首图 URL", cell: ({ row }) => <span className="si-edm-feed-cell"><ImageThumbnail src={row.original.feed_image_url} label={row.original.sku + " Feed 首图"} /><code title={row.original.feed_image_url ?? undefined}>{feedImageLabel(row.original.feed_image_url)}</code></span> },
    { id: "manual_image_url", accessorKey: "manual_image_url", header: "手动输入的首图 URL", cell: ({ row }) => <ManualImageCell projectId={projectId} row={row.original} /> },
    { id: "used", accessorKey: "used", header: "agent 使用", cell: ({ row }) => <Chip tone={row.original.used === "manual" ? "info" : row.original.used === "feed" ? "ok" : "danger"}>{row.original.used === "manual" ? "手动首图" : row.original.used === "feed" ? "抓取首图" : "缺图"}</Chip>, enableSorting: true },
  ];
}

export function EdmPage() {
  const { id = "kingsyard" } = useParams();
  const [query, setQuery] = useState<ListQuery<SkuImageFilters>>({ page: 1, pageSize: 20, filters: {} });
  const [selected, setSelected] = useState<SkuImageRow | null>(null);
  const [feedback, setFeedback] = useState("");
  const projectQuery = useQuery({ queryKey: projectQueryKeys.detail(id), queryFn: () => api.projects.get(id) });
  const summaryQuery = useQuery({ queryKey: ["edm", "summary", id], queryFn: () => api.edm.summary(id) });
  const listQuery = useQuery({ queryKey: ["edm", "images", id, query], queryFn: () => api.edm.listImages(id, query) });
  const project = projectQuery.data?.summary;
  const summary = summaryQuery.data;
  const columns = useMemo(() => imageColumns(id), [id]);
  const currentView: ImageView = query.filters?.view ?? "all";
  const metrics: Kpi[] = summary ? [
    { key: "total", label: "SKU", value: String(summary.total) },
    { key: "feed", label: "有抓取首图", value: String(summary.feed), hint: "来自商品 Feed" },
    { key: "manual", label: "有手动首图", value: String(summary.manual), hint: "保存到本机 EDM 图片表" },
    { key: "none", label: "缺图（两者都没有）", value: String(summary.none), tone: summary.none ? "warn" : "default" },
  ] : [];

  const setSearch = (search: string) => setQuery((current) => ({ ...current, page: 1, search: search || undefined }));
  const copyCommand = async () => {
    try {
      const input: EdmCommandInput = { theme: "当前 EDM 活动", count: summary?.total ?? 1 };
      const command = await api.edm.buildCommand(id, input);
      await api.shell.copyText(command);
      setFeedback("edm-builder 指令已复制。可以粘贴给内容 agent 使用。");
    } catch (cause) { setFeedback(apiErrorMessage(cause, "复制指令失败。")); }
  };
  const openProjectFolder = async () => {
    try { await api.shell.openPath(projectQuery.data?.summary.path ?? ""); }
    catch (cause) { setFeedback(apiErrorMessage(cause, "无法打开项目文件夹。")); }
  };
  if (projectQuery.isLoading) return <div className="si-page-loading" role="status">正在加载项目信息…</div>;
  if (projectQuery.isError || !project) return <ApiErrorNotice page label="项目 EDM 页面加载失败。" error={projectQuery.error} onRetry={() => void projectQuery.refetch()} />;

  return <div className="si-page si-edm-page">
    <ProjectHeader project={project} activeTab="edm" hasTabPanel actions={<><Button onClick={() => void openProjectFolder()}>打开项目文件夹</Button><Button onClick={() => void copyCommand()}><Copy size={14} />复制 edm-builder 指令</Button></>} />
    <ProjectTabPanel projectId={project.id} tab="edm">
    <div className="si-edm-kpis">{summaryQuery.isLoading ? <div className="si-query-loading" role="status">正在加载 EDM 概览…</div> : summaryQuery.isError || !summary ? <ApiErrorNotice label="EDM 概览加载失败。" error={summaryQuery.error} onRetry={() => void summaryQuery.refetch()} /> : metrics.map((metric) => <KpiCard key={metric.key} metric={metric} />)}</div>
    {feedback && <p className="si-feedback" role="status">{feedback}</p>}
    {listQuery.isLoading ? <div className="si-query-loading" role="status">正在加载 SKU 图片…</div> : listQuery.isError ? <ApiErrorNotice label="SKU 图片列表加载失败。" error={listQuery.error} onRetry={() => void listQuery.refetch()} /> : <DataTable
      tableId="edm.images" rows={listQuery.data?.rows ?? []} total={listQuery.data?.total ?? 0} columns={columns}
      query={query} onQueryChange={setQuery} onRowClick={setSelected} getRowId={(row) => row.sku} maxHeight={520}
      showPagination={false} emptyTitle="没有 SKU 图片记录" emptyDescription="检查产品目录与 Feed 图片地址。"
      toolbar={<div className="si-edm-toolbar">
        <div className="si-edm-toolbar-top"><h2>SKU 宣传图</h2><SearchInput value={query.search ?? ""} onSearch={setSearch} label="搜索 SKU 图片" placeholder="搜索 SKU、标题" />
          <div className="si-content-filter-row">{viewOptions.map((item) => <FilterPill key={item.value} currentValue={currentView} value={item.value} onValueChange={(value) => setQuery((current) => ({ ...current, page: 1, filters: { ...current.filters, view: !value || value === "all" ? undefined : value } }))}>{item.label}</FilterPill>)}</div>
          <span className="si-content-total">显示 {listQuery.data?.total ?? 0} 个</span>
        </div>
      </div>}
    />}
    <p className="si-edm-rule-note"><strong>规则：</strong><span>agent 默认使用抓取到的首图；没有抓取到时使用手动输入的首图；两者都没有则该 SKU 不进入 EDM。手动首图写入 <code>index/ledgers/sku_media.csv</code>，每日同步不会覆盖。</span></p>
    <DetailPanel open={Boolean(selected)} onClose={() => setSelected(null)} title={selected?.title ?? "SKU 图片详情"}>
      {selected && <div className="si-edm-detail">
        <ImageThumbnail src={selected.manual_image_url || selected.feed_image_url} label={selected.sku + " 当前使用图片"} />
        <div><span>SKU</span><code>{selected.sku}</code></div><div><span>变体</span>{selected.variant_title || "默认款"}</div>
        <div><span>库存状态</span><Chip tone={stockTone[selected.stock_status]}>{stockLabels[selected.stock_status]}</Chip></div>
        <div><span>agent 使用</span>{selected.used === "manual" ? "手动首图" : selected.used === "feed" ? "抓取首图" : "缺图"}</div>
        <div className="full"><span>抓取到的首图 URL</span><code>{selected.feed_image_url || "未抓取"}</code></div>
        <div className="full"><span>手动输入的首图 URL</span><code>{selected.manual_image_url || "未设置"}</code></div>
        {(selected.manual_image_url?.startsWith("http://") || selected.manual_image_url?.startsWith("https://") || selected.feed_image_url?.startsWith("http://") || selected.feed_image_url?.startsWith("https://")) && <Button size="small" onClick={() => {
          const url = [selected.manual_image_url, selected.feed_image_url].find((item) => item?.startsWith("http://") || item?.startsWith("https://"));
          if (url) void api.shell.openExternal(url);
        }}><ExternalLink size={13} />打开图片</Button>}
      </div>}
    </DetailPanel>
    </ProjectTabPanel>
  </div>;
}
import "./edm/page.css";
