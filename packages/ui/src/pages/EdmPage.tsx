import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { Copy, ExternalLink, Image as ImageIcon } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import type { EdmCommandInput, Kpi, ListQuery, SkuGroupingRule, SkuImageFilters, SkuImageRow, StockStatus } from "@siteindex/shared";
import { api, apiErrorMessage, isMockApi } from "../api";
import { projectQueryKeys } from "../project-queries";
import { ApiErrorNotice, Button, Chip, DataTable, DetailPanel, Drawer, FilterPill, KpiCard, Notice, ProjectHeader, ProjectTabPanel, SearchInput, stockTone, useToast } from "../components";
import { fetchSkuGroupingPreview, skuGroupingPreviewQueryKey } from "./project-settings-config/sku-grouping-preview";

type ImageView = NonNullable<SkuImageFilters["view"]> | "all";
const stockLabels: Record<StockStatus, string> = { in_stock: "有货", out_of_stock: "缺货", preorder: "预售", unknown: "未知" };
const viewOptions: { value: ImageView; label: string }[] = [
  { value: "all", label: "全部" }, { value: "in_stock", label: "有货" }, { value: "no_feed", label: "未抓取到首图" },
  { value: "has_manual", label: "已填手动图" }, { value: "none", label: "缺图" },
];

function EdmGroupingPreview({ projectId, rule, enabled }: { projectId: string; rule: SkuGroupingRule; enabled: boolean }) {
  const previewQuery = useQuery({
    queryKey: skuGroupingPreviewQueryKey(projectId, rule),
    queryFn: () => fetchSkuGroupingPreview(api, projectId, rule),
    enabled,
    staleTime: 60_000,
  });
  const preview = previewQuery.data;
  return <div className="si-edm-grouping-preview">
    <div className="si-edm-grouping-rule"><span>当前规则</span><code>{rule.type} · {rule.value}</code></div>
    {previewQuery.isLoading ? <p role="status">正在通过 Core 计算 SKU 分组预览…</p>
      : previewQuery.isError ? <ApiErrorNotice label="SKU 分组预览加载失败。" error={previewQuery.error} onRetry={() => void previewQuery.refetch()} />
        : preview ? <>
          <div className="si-edm-grouping-stats"><span><strong>{preview.parents}</strong> 个父 SKU</span><span>已匹配 <strong>{preview.children}</strong> 个子 SKU</span><span>未匹配 <strong>{preview.unmatched}</strong> 个</span></div>
          {preview.samples.length > 0 ? <ul>{preview.samples.slice(0, 6).map((sample) => <li key={sample.parent}><code>{sample.parent}</code><span>{sample.children.length} 个：{sample.children.slice(0, 4).join("、")}{sample.children.length > 4 ? " …" : ""}</span></li>)}</ul> : <p>当前规则没有可展示的分组样例。</p>}
          {preview.collisions?.length ? <details><summary>有 {preview.collisions.length} 组父 SKU 本身也在售，已跳过分组</summary><ul>{preview.collisions.map((collision) => <li key={collision.parent}><code>{collision.parent}</code><span>子 SKU：{collision.children.length ? collision.children.join("、") : "未提供明细"}</span></li>)}</ul></details> : null}
          <small>规则预览不代表父 SKU 的库存或在线率。</small>
        </> : <p role="status">正在准备 SKU 分组预览…</p>}
  </div>;
}

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
  const toast = useToast();
  const [url, setUrl] = useState(row.manual_image_url ?? "");
  useEffect(() => { setUrl(row.manual_image_url ?? ""); }, [row.manual_image_url]);
  const mutation = useMutation({
    mutationFn: () => api.edm.setManualImage(projectId, row.sku, url.trim() || null),
    onSuccess: async () => {
      toast.success("手动首图已保存。");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["edm", "images", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["edm", "summary", projectId] }),
      ]);
    },
    onError: (cause) => toast.error(apiErrorMessage(cause, "手动首图保存失败。")),
  });
  return <div className="si-edm-manual-cell">
    <input type="url" aria-label={row.sku + " 手动首图地址"} value={url} placeholder="粘贴 Mailchimp 等图片地址" onChange={(event) => setUrl(event.target.value)} />
    <Button size="small" disabled={mutation.isPending} onClick={() => mutation.mutate()}>{mutation.isPending ? "保存中" : "保存"}</Button>
  </div>;
}

function feedImageLabel(url: string | null): string {
  if (!url) return "未抓取到首图";
  try { return new URL(url).pathname; } catch { return url; }
}

function imageColumns(projectId: string): ColumnDef<SkuImageRow, unknown>[] {
  return [
    { id: "sku", accessorKey: "sku", header: "SKU", meta: { width: 150, grow: 0, minWidth: 130, text: "single" }, cell: ({ row }) => <code className="si-edm-sku">{row.original.sku}</code>, enableSorting: true },
    { id: "product", accessorKey: "title", header: "产品 / 变体", meta: { width: 280, grow: 2, minWidth: 200, text: "single" }, cell: ({ row }) => <span className="si-edm-product"><strong>{row.original.title}</strong><small>{row.original.variant_title || "默认款"}</small></span>, enableSorting: true },
    { id: "stock_status", accessorKey: "stock_status", header: "库存", meta: { width: 88, grow: 0, minWidth: 88, text: "single" }, cell: ({ row }) => <Chip tone={stockTone[row.original.stock_status]}>{stockLabels[row.original.stock_status]}</Chip>, enableSorting: true },
    { id: "feed_image_url", accessorKey: "feed_image_url", header: "抓取到的首图 URL", meta: { width: 320, grow: 2, minWidth: 220, text: "single" }, cell: ({ row }) => <span className="si-edm-feed-cell"><ImageThumbnail src={row.original.feed_image_url} label={row.original.sku + " Feed 首图"} /><code title={row.original.feed_image_url ?? undefined}>{feedImageLabel(row.original.feed_image_url)}</code></span> },
    { id: "manual_image_url", accessorKey: "manual_image_url", header: "手动输入的首图 URL", meta: { width: 340, grow: 2, minWidth: 280, text: "single" }, cell: ({ row }) => <ManualImageCell projectId={projectId} row={row.original} /> },
    { id: "used", accessorKey: "used", header: "agent 使用", meta: { width: 100, grow: 0, minWidth: 96, text: "single" }, cell: ({ row }) => <Chip tone={row.original.used === "manual" ? "info" : row.original.used === "feed" ? "ok" : "danger"}>{row.original.used === "manual" ? "手动首图" : row.original.used === "feed" ? "抓取首图" : "缺图"}</Chip>, enableSorting: true },
  ];
}

export function EdmPage() {
  const { id = "demo" } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [query, setQuery] = useState<ListQuery<SkuImageFilters>>({ page: 1, pageSize: 50, filters: {} });
  const [selected, setSelected] = useState<SkuImageRow | null>(null);
  const [groupingDrawerOpen, setGroupingDrawerOpen] = useState(false);
  const projectQuery = useQuery({ queryKey: projectQueryKeys.detail(id), queryFn: () => api.projects.get(id) });
  const summaryQuery = useQuery({ queryKey: ["edm", "summary", id], queryFn: () => api.edm.summary(id) });
  const listQuery = useQuery({ queryKey: ["edm", "images", id, query], queryFn: () => api.edm.listImages(id, query) });
  const project = projectQuery.data?.summary;
  const skuGrouping = projectQuery.data?.config.sku_grouping;
  const groupingEnabled = skuGrouping?.enabled === true;
  const groupingRule: SkuGroupingRule = skuGrouping?.rule ?? { type: "separator", value: "-" };
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
  const onParentOnlyChange = (checked: boolean) => {
    if (!groupingEnabled) {
      setQuery((current) => ({ ...current, page: 1, filters: { ...current.filters, parent_only: undefined } }));
      if (checked) setGroupingDrawerOpen(true);
      return;
    }
    setQuery((current) => ({ ...current, page: 1, filters: { ...current.filters, parent_only: checked || undefined } }));
  };
  const openGroupingSettings = () => {
    setGroupingDrawerOpen(false);
    navigate("/p/" + id + "/settings/config?section=sku-grouping");
  };
  const copyCommand = async () => {
    try {
      const input: EdmCommandInput = { theme: "当前 EDM 活动", count: summary?.total ?? 1 };
      const command = await api.edm.buildCommand(id, input);
      await api.shell.copyText(command);
      toast.success("edm-builder 指令已复制。");
    } catch (cause) { toast.error(apiErrorMessage(cause, "复制指令失败。")); }
  };
  const openProjectFolder = async () => {
    try { await api.shell.openPath(projectQuery.data?.summary.path ?? ""); toast.success("已打开项目文件夹。"); }
    catch (cause) { toast.error(apiErrorMessage(cause, "无法打开项目文件夹。")); }
  };
  const openSelectedImage = async () => {
    const url = [selected?.manual_image_url, selected?.feed_image_url].find((item) => item?.startsWith("http://") || item?.startsWith("https://"));
    if (!url) return;
    try { await api.shell.openExternal(url); toast.success("已打开图片地址。"); }
    catch (cause) { toast.error(apiErrorMessage(cause, "无法打开图片地址。")); }
  };
  if (projectQuery.isLoading) return <div className="si-page-loading" role="status">正在加载项目信息…</div>;
  if (projectQuery.isError || !project) return <ApiErrorNotice page label="项目 EDM 页面加载失败。" error={projectQuery.error} onRetry={() => void projectQuery.refetch()} />;

  return <div className="si-page si-edm-page">
    <ProjectHeader project={project} activeTab="edm" hasTabPanel actions={<><Button onClick={() => void openProjectFolder()}>打开项目文件夹</Button><Button onClick={() => void copyCommand()}><Copy size={14} />复制 edm-builder 指令</Button></>} />
    <ProjectTabPanel projectId={project.id} tab="edm">
    <div className="si-edm-kpis">{summaryQuery.isLoading ? <div className="si-query-loading" role="status">正在加载 EDM 概览…</div> : summaryQuery.isError || !summary ? <ApiErrorNotice label="EDM 概览加载失败。" error={summaryQuery.error} onRetry={() => void summaryQuery.refetch()} /> : metrics.map((metric) => <KpiCard key={metric.key} metric={metric} />)}</div>
    {listQuery.isLoading ? <div className="si-query-loading" role="status">正在加载 SKU 图片…</div> : listQuery.isError ? <ApiErrorNotice label="SKU 图片列表加载失败。" error={listQuery.error} onRetry={() => void listQuery.refetch()} /> : <DataTable
      tableId="edm.images" rows={listQuery.data?.rows ?? []} total={listQuery.data?.total ?? 0} columns={columns}
      query={query} onQueryChange={setQuery} onRowClick={setSelected} getRowId={(row) => row.sku} height="fill" rowHeight={48}
      emptyTitle="没有 SKU 图片记录" emptyDescription="检查产品目录与 Feed 图片地址。"
      toolbar={<div className="si-edm-toolbar">
        <div className="si-edm-toolbar-top"><h2>SKU 宣传图</h2><SearchInput value={query.search ?? ""} onSearch={setSearch} label="搜索 SKU 图片" placeholder="搜索 SKU、标题" />
          <label className="si-edm-parent-toggle"><input type="checkbox" aria-label="仅展示父 SKU" checked={Boolean(query.filters?.parent_only && groupingEnabled)} onChange={(event) => onParentOnlyChange(event.target.checked)} /><span>仅展示父 SKU</span></label>
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
        {(selected.manual_image_url?.startsWith("http://") || selected.manual_image_url?.startsWith("https://") || selected.feed_image_url?.startsWith("http://") || selected.feed_image_url?.startsWith("https://")) && <Button size="small" onClick={() => void openSelectedImage()}><ExternalLink size={13} />打开图片</Button>}
      </div>}
    </DetailPanel>
    <Drawer open={groupingDrawerOpen} onOpenChange={setGroupingDrawerOpen} title="配置父子 SKU 规则" description="仅当项目启用分组后，EDM 图片列表才会筛选父 SKU。预览由 Core 计算。" footer={<div className="si-edm-drawer-actions"><Button onClick={() => setGroupingDrawerOpen(false)}>关闭</Button><Button variant="primary" onClick={openGroupingSettings}>前往项目设置</Button></div>}>
      <Notice tone="warn" title="当前未启用父子 SKU 分组">“仅展示父 SKU”暂时不会改变 EDM 图片列表。先在项目设置中启用规则，再返回这里筛选。</Notice>
      <EdmGroupingPreview projectId={id} rule={groupingRule} enabled={groupingDrawerOpen} />
    </Drawer>
    </ProjectTabPanel>
  </div>;
}
import "./edm/page.css";
