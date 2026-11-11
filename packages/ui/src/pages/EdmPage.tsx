import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { Copy, ExternalLink, Image as ImageIcon } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import type { EdmCommandInput, EdmSkuIndexExportResult, JobResult, Kpi, ListQuery, MediaPrepareSkuResult, RunLog, SkuGroupingRule, SkuImageFilters, SkuImageRow, StockStatus } from "@siteindex/shared";
import { api, apiErrorMessage, isMockApi } from "../api";
import { projectQueryKeys } from "../project-queries";
import { ApiErrorNotice, Button, Chip, DataTable, DetailPanel, Drawer, FilterPill, KpiCard, Notice, ProjectHeader, ProjectTabPanel, SearchInput, Select, stockTone, useToast } from "../components";
import { fetchSkuGroupingPreview, skuGroupingPreviewQueryKey } from "./project-settings-config/sku-grouping-preview";
import { getEdmMediaCapability } from "./edm/media-capability";
import { edmMediaJobMonitor, type EdmMediaRunSnapshot } from "./edm/media-job-monitor";
import { getEdmExportCapability, isEdmExportDefinitiveNoWrite, isEdmExportOutcomeUnknown } from "./edm/export-capability";
import { beginEdmExportAttempt, getEdmExportSafetyState, keepEdmExportAttemptBlocked, resolveEdmExportAttempt, subscribeEdmExportSafety } from "./edm/export-retry-state";
import { getMediaRecoveryDisplay, mediaRecoveryErrorMessage, type MediaRecoveryDisplay, type MediaRecoveryRowStatus } from "./edm/media-recovery";
import { EDM_MEDIA_HISTORY_LIMIT, selectEdmMediaDisplay } from "./edm/media-history";
import { EdmWorkflowPrototype } from "./edm/workflow-prototype";

type ImageView = NonNullable<SkuImageFilters["view"]> | "all";
const stockLabels: Record<StockStatus, string> = { in_stock: "有货", out_of_stock: "缺货", preorder: "预售", unknown: "未知" };
const viewOptions: { value: ImageView; label: string }[] = [
  { value: "all", label: "全部" }, { value: "in_stock", label: "有货" }, { value: "no_feed", label: "未抓取到首图" },
  { value: "has_manual", label: "已填手动图" }, { value: "none", label: "缺图" },
];

type MediaDemoStatus = "queued" | MediaPrepareSkuResult["status"] | "unresolved" | MediaRecoveryRowStatus;
type MediaDemoRowState = { status: MediaDemoStatus; reason?: string };
type MediaDemoOutcome = "complete" | "WP_AUTH_FAILED" | "WP_FORBIDDEN";

const mediaStatusLabels: Record<MediaDemoStatus, string> = {
  queued: "排队中", uploaded: "已上传", reused: "已复用",
  recorded: "原图 URL 已记录", skipped_has_url: "已有 URL，已跳过",
  failed: "失败", unresolved: "尚未开始", unknown: "结果未知",
  not_started: "已确认未开始", unavailable: "无法恢复",
};

const mediaStatusTones: Record<MediaDemoStatus, "neutral" | "info" | "ok" | "warn" | "danger"> = {
  queued: "warn", uploaded: "ok", reused: "info", recorded: "info",
  skipped_has_url: "neutral", failed: "danger", unresolved: "warn", unknown: "warn",
  not_started: "neutral", unavailable: "warn",
};

function summarizeMediaRun(skus: string[], result: JobResult): string {
  const labels: Record<MediaPrepareSkuResult["status"], string> = {
    uploaded: "上传", reused: "复用", recorded: "记录原图 URL", skipped_has_url: "已有 URL 跳过", failed: "失败",
  };
  const recovery = getMediaRecoveryDisplay(result, skus);
  const authMessage = recovery.errorCode ? mediaRecoveryErrorMessage(recovery.errorCode) : "";
  if (recovery.kind !== "available") {
    const note = recovery.kind === "legacy"
      ? "旧版任务结果没有逐 SKU 恢复字段，无法确认各 SKU 状态；请先核对图片 URL 与台账。"
      : "任务返回的逐 SKU 恢复字段不完整或与请求范围不一致，无法确认状态；请先核对图片 URL 与台账。";
    return [authMessage, result.summary, note].filter(Boolean).join(" ") || note;
  }

  const counts = new Map<MediaPrepareSkuResult["status"], number>();
  for (const row of recovery.rows) {
    if (row.status in labels) counts.set(row.status as MediaPrepareSkuResult["status"], (counts.get(row.status as MediaPrepareSkuResult["status"]) ?? 0) + 1);
  }
  const summaryParts = [...counts].map(([status, count]) => `${labels[status]} ${count}`);
  const unknownCount = recovery.rows.filter(({ status }) => status === "unknown").length;
  const notStartedCount = recovery.rows.filter(({ status }) => status === "not_started").length;
  if (unknownCount) summaryParts.push(`结果未知 ${unknownCount}`);
  if (notStartedCount) summaryParts.push(`已确认未开始 ${notStartedCount}`);
  const batchNote = recovery.batchState === "interrupted" ? "批次已中断。"
    : recovery.batchState === "outcome_unknown" ? "部分外部处理结果未知。" : "";
  return [authMessage, result.summary, batchNote, summaryParts.join("，")].filter(Boolean).join(" ") || "图片准备任务已结束。";
}

function getMediaRunStatuses(skus: string[], state: EdmMediaRunSnapshot["state"], result?: JobResult): Record<string, MediaDemoRowState> {
  if (state === "starting" || state === "running") {
    return Object.fromEntries(skus.map((sku) => [sku, { status: "queued" as const }]));
  }
  if (!result) return {};
  const recovery = getMediaRecoveryDisplay(result, skus);
  return Object.fromEntries(recovery.rows.map(({ sku, status, reason }) => [sku, { status, ...(reason ? { reason } : {}) }]));
}

function mediaRecoverySummary(recovery: MediaRecoveryDisplay): string {
  const authMessage = recovery.errorCode ? mediaRecoveryErrorMessage(recovery.errorCode) : "";
  if (recovery.kind === "legacy") return [authMessage, "旧版任务记录没有逐 SKU 恢复字段，无法确认已处理、结果未知或尚未开始的 SKU。请先核对图片 URL 与台账，再决定是否重新处理。"].filter(Boolean).join(" ");
  if (recovery.kind === "invalid") return [authMessage, "任务恢复数据不完整或分区不一致，无法安全推断 SKU 状态。请先核对图片 URL 与台账。"].filter(Boolean).join(" ");
  const batchMessage = recovery.batchState === "interrupted" ? "最近批次已中断；“已确认未开始”仅来自 Core 明确返回的未开始清单。"
    : recovery.batchState === "outcome_unknown" ? "至少一个 SKU 的外部处理结果未知。请先核对图片 URL 与台账，再决定是否重试。"
      : "最近批次的逐 SKU 结果已确认。";
  return [authMessage, batchMessage].filter(Boolean).join(" ");
}

function MediaHistoryRecovery({ run, stale = false }: { run: RunLog; stale?: boolean }) {
  const recovery = getMediaRecoveryDisplay(run);
  const tone = recovery.errorCode ? "error" : !stale && recovery.kind === "available" && recovery.batchState === "complete" ? "info" : "warn";
  return <section className="si-edm-history-recovery" aria-label="最近一次图片处理恢复结果">
    <Notice tone={tone} title="最近一次图片处理记录">{mediaRecoverySummary(recovery)}</Notice>
    <p className="si-edm-history-limit">{stale && "历史刷新失败，以下为缓存记录，可能不是最新。"}查询范围：最近 {EDM_MEDIA_HISTORY_LIMIT} 条任务记录（包含所有任务类型）；更早记录可能不在结果中。</p>
    {recovery.rows.length > 0 && <ul className="si-edm-media-demo-results" aria-label="最近任务逐 SKU 恢复结果">
      {recovery.rows.map(({ sku, status, reason }) => <li key={sku}>
        <code>{sku}</code><Chip tone={mediaStatusTones[status]}>{mediaStatusLabels[status]}</Chip>{reason && <small>{reason}</small>}
      </li>)}
    </ul>}
  </section>;
}

function exportResultMessage(result: EdmSkuIndexExportResult): string {
  const status = result.status === "created" ? "清单已创建"
    : result.status === "updated" ? "清单已更新" : "清单已是最新";
  return `${status}：${result.sku_count} 个 SKU，待补图 ${result.missing_image_count} 个。`;
}

function getExportErrorMessage(error: unknown): { tone: "warn" | "error"; message: string } {
  if (isEdmExportOutcomeUnknown(error)) {
    return { tone: "warn", message: "写入结果尚未确认；清单可能已经生成。此页面不会盲目重试，请先核对目标标记、当前内容与预期输出。" };
  }
  if (error && typeof error === "object" && "code" in error && error.code === "EDM_INDEX_CONFLICT") {
    return { tone: "error", message: "清单目标存在冲突，未覆盖已有文件。请先检查目标文件后重试。" };
  }
  if (error && typeof error === "object" && "code" in error && error.code === "WRITE_FAILED") {
    return { tone: "error", message: "清单写入失败，后端确认目标未写入。请检查目标文件和权限后再试。" };
  }
  return {
    tone: "warn",
    message: "导出请求失败且无法确认目标文件是否已更新。此页面不会盲目重试，请先核对目标标记、当前内容与预期输出。",
  };
}

function isRecordableFeedImage(url: string): boolean {
  try {
    return /\.(?:jpe?g|png)$/i.test(new URL(url, "https://siteindex.invalid").pathname);
  } catch {
    return false;
  }
}

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
  const lastResetProjectIdRef = useRef(id);
  const mediaPageVisitRef = useRef({ projectId: id, startedAt: Date.now() });
  if (mediaPageVisitRef.current.projectId !== id) mediaPageVisitRef.current = { projectId: id, startedAt: Date.now() };
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const mediaRunSnapshot = useSyncExternalStore(
    edmMediaJobMonitor.subscribe,
    () => edmMediaJobMonitor.getSnapshot(id),
    () => null,
  );
  const mediaSnapshotActive = mediaRunSnapshot?.state === "starting" || mediaRunSnapshot?.state === "running";
  const exportSafetyState = useSyncExternalStore(
    (listener) => subscribeEdmExportSafety(id, listener),
    () => getEdmExportSafetyState(id),
    () => "unavailable" as const,
  );
  const [query, setQuery] = useState<ListQuery<SkuImageFilters>>({ page: 1, pageSize: 50, filters: {} });
  const [selected, setSelected] = useState<SkuImageRow | null>(null);
  const [selectedRows, setSelectedRows] = useState<SkuImageRow[]>([]);
  const [mediaDemoStatuses, setMediaDemoStatuses] = useState<Record<string, MediaDemoRowState>>({});
  const [mediaDemoOutcome, setMediaDemoOutcome] = useState<MediaDemoOutcome>("complete");
  const [mediaDemoRunning, setMediaDemoRunning] = useState(false);
  const [mediaDemoMessage, setMediaDemoMessage] = useState("");
  const [mediaDemoOpen, setMediaDemoOpen] = useState(false);
  const [exportFeedback, setExportFeedback] = useState<
    | { projectId: string; result: EdmSkuIndexExportResult; safetyWarning?: string }
    | { projectId: string; error: { tone: "warn" | "error"; message: string } }
    | null
  >(null);
  const [exportSafetyUnavailableProjectId, setExportSafetyUnavailableProjectId] = useState<string | null>(null);
  const [groupingDrawerOpen, setGroupingDrawerOpen] = useState(false);
  const projectQuery = useQuery({ queryKey: projectQueryKeys.detail(id), queryFn: () => api.projects.get(id) });
  const summaryQuery = useQuery({ queryKey: ["edm", "summary", id], queryFn: () => api.edm.summary(id) });
  const listQuery = useQuery({ queryKey: ["edm", "images", id, query], queryFn: () => api.edm.listImages(id, query) });
  const mediaHistoryQuery = useQuery({
    queryKey: ["job-history", id],
    queryFn: () => api.jobs.history(id, EDM_MEDIA_HISTORY_LIMIT),
    enabled: !isMockApi && !mediaSnapshotActive,
    staleTime: 0,
  });
  const project = projectQuery.data?.summary;
  const skuGrouping = projectQuery.data?.config.sku_grouping;
  const mediaCapability = getEdmMediaCapability(api);
  const exportCapability = getEdmExportCapability(api);
  const exportIndex = api.edm.exportIndex;
  const mediaDisplaySelection = selectEdmMediaDisplay(
    mediaRunSnapshot,
    mediaHistoryQuery.data,
    mediaHistoryQuery.isError ? "error" : mediaHistoryQuery.isLoading ? "loading" : "success",
    mediaPageVisitRef.current.startedAt,
  );
  const displayedMediaSnapshot = mediaDisplaySelection.kind === "snapshot" ? mediaDisplaySelection.snapshot : null;
  const exportSafetyBlocked = exportSafetyState !== "ready" || exportSafetyUnavailableProjectId === id;
  const currentExportFeedback = exportFeedback?.projectId === id ? exportFeedback : null;
  const exportMutation = useMutation({
    mutationFn: async ({ projectId }: { projectId: string; attemptId: string }) => {
      if (!exportCapability.available || !exportIndex) throw new Error("EDM 清单导出尚未就绪。");
      return exportIndex(projectId);
    },
    onMutate: () => setExportFeedback(null),
    onSuccess: (result, { projectId, attemptId }) => {
      const markerResolved = resolveEdmExportAttempt(projectId, attemptId, exportCapability.reconciliationVerified);
      const safetyWarning = markerResolved ? undefined : "结果已确认，但本机无法解除导出状态门闩；请检查本地存储后再继续。";
      setExportFeedback({ projectId, result, ...(safetyWarning ? { safetyWarning } : {}) });
      const message = exportResultMessage(result);
      if (safetyWarning) toast.error(safetyWarning);
      else if (result.status === "unchanged") toast.info(message);
      else toast.success(message);
    },
    onError: (error, { projectId, attemptId }) => {
      const feedback = getExportErrorMessage(error);
      if (isEdmExportDefinitiveNoWrite(error)) resolveEdmExportAttempt(projectId, attemptId, exportCapability.reconciliationVerified);
      else if (!exportCapability.reconciliationVerified) keepEdmExportAttemptBlocked(projectId, attemptId);
      setExportFeedback({ projectId, error: feedback });
      if (feedback.tone === "warn") toast.info(feedback.message);
      else toast.error(feedback.message);
    },
  });
  const startExport = () => {
    if (!exportCapability.available || !exportIndex || exportSafetyBlocked) return;
    const attemptId = beginEdmExportAttempt(id, exportCapability.reconciliationVerified);
    if (!attemptId) {
      const safetyState = getEdmExportSafetyState(id, exportCapability.reconciliationVerified);
      if (safetyState === "unavailable") setExportSafetyUnavailableProjectId(id);
      const message = safetyState === "blocked"
        ? "本机已有未确认的导出门闩；请求尚未发送。请先核查目标文件。"
        : "无法保存本次导出的确认状态，请检查本地存储。请求尚未发送，导出操作已暂停。";
      setExportFeedback({ projectId: id, error: { tone: "warn", message } });
      toast.error(message);
      return;
    }
    exportMutation.mutate({ projectId: id, attemptId });
  };
  // History display selection must not release the active task's in-page guard.
  const mediaRunBusy = mediaSnapshotActive;
  const mediaRunProgress = mediaSnapshotActive ? mediaRunSnapshot.progress : "";
  const mediaRunMessage = displayedMediaSnapshot?.state === "failed" ? displayedMediaSnapshot.error ?? "图片处理任务启动失败。"
    : displayedMediaSnapshot?.result ? summarizeMediaRun(displayedMediaSnapshot.skus, displayedMediaSnapshot.result) : "";
  const mediaRunRecovery = displayedMediaSnapshot?.result ? getMediaRecoveryDisplay(displayedMediaSnapshot.result, displayedMediaSnapshot.skus) : null;
  const mediaRunTone = displayedMediaSnapshot?.state === "failed" || displayedMediaSnapshot?.result?.status === "failed" || mediaRunRecovery?.errorCode ? "error"
    : displayedMediaSnapshot?.result?.status === "partial" || mediaRunRecovery?.kind === "invalid" || mediaRunRecovery?.kind === "legacy" || (mediaRunRecovery?.kind === "available" && mediaRunRecovery.batchState !== "complete") ? "warn" : "info";
  const mediaRunStatuses = displayedMediaSnapshot ? getMediaRunStatuses(displayedMediaSnapshot.skus, displayedMediaSnapshot.state, displayedMediaSnapshot.result) : {};
  const groupingEnabled = skuGrouping?.enabled === true;
  const groupingRule: SkuGroupingRule = skuGrouping?.rule ?? { type: "separator", value: "-" };
  const summary = summaryQuery.data;
  const columns = useMemo(() => imageColumns(id), [id]);
  const currentView: ImageView = query.filters?.view ?? "all";

  useEffect(() => {
    return edmMediaJobMonitor.connect(api.jobs, queryClient, toast);
  }, [api.jobs, queryClient, toast]);

  useEffect(() => {
    if (lastResetProjectIdRef.current === id) return;
    lastResetProjectIdRef.current = id;
    setSelected(null);
    setSelectedRows([]);
    setMediaDemoStatuses({});
    setMediaDemoRunning(false);
    setMediaDemoMessage("");
  }, [id]);
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
  const simulateMediaPreparation = () => {
    if (!isMockApi || mediaDemoRunning || selectedRows.length === 0) return;
    const batch = [...selectedRows];
    setMediaDemoRunning(true);
    setMediaDemoMessage("");
    setMediaDemoStatuses((current) => ({
      ...current,
      ...Object.fromEntries(batch.map((row) => [row.sku, { status: "queued" as const }])),
    }));
    window.setTimeout(() => {
      const next: Record<string, MediaDemoRowState> = {};
      const counts = { uploaded: 0, reused: 0, recorded: 0, skipped_has_url: 0, failed: 0, unresolved: 0 };
      const uploadStatuses: Extract<MediaPrepareSkuResult["status"], "uploaded" | "reused" | "failed">[] = ["uploaded", "reused", "failed"];
      let eligibleCount = 0;
      let stopped = false;
      for (const row of batch) {
        if (stopped) {
          next[row.sku] = { status: "unresolved", reason: "批次提前停止，未开始处理" };
          counts.unresolved += 1;
        } else if (row.manual_image_url) {
          next[row.sku] = { status: "skipped_has_url", reason: "图片台账中已有 URL" };
          counts.skipped_has_url += 1;
        } else if (row.feed_image_url && isRecordableFeedImage(row.feed_image_url)) {
          next[row.sku] = { status: "recorded", reason: "Feed JPG/PNG 原图 URL 可直接记录" };
          counts.recorded += 1;
        } else if (!row.feed_image_url) {
          next[row.sku] = { status: "failed", reason: "没有可处理的 Feed 图片 URL" };
          counts.failed += 1;
        } else if (mediaDemoOutcome !== "complete") {
          next[row.sku] = { status: "failed", reason: mediaDemoOutcome + "（模拟停批）" };
          counts.failed += 1;
          stopped = true;
        } else {
          const status = uploadStatuses[eligibleCount % uploadStatuses.length]!;
          next[row.sku] = { status, ...(status === "failed" ? { reason: "模拟单 SKU 失败" } : {}) };
          counts[status] += 1;
          eligibleCount += 1;
        }
      }
      setMediaDemoStatuses((current) => ({ ...current, ...next }));
      const parts = [
        counts.uploaded && `上传 ${counts.uploaded}`,
        counts.reused && `复用 ${counts.reused}`,
        counts.recorded && `记录 ${counts.recorded}`,
        counts.skipped_has_url && `已有 URL 跳过 ${counts.skipped_has_url}`,
        counts.failed && `失败 ${counts.failed}`,
        counts.unresolved && `尚未开始 ${counts.unresolved}`,
      ].filter(Boolean);
      const resultText = parts.length ? parts.join("，") : "没有可处理的行";
      setMediaDemoMessage(mediaDemoOutcome === "complete"
        ? resultText
        : stopped
          ? `${mediaDemoOutcome}：模拟批次提前停止；${resultText}。`
          : `${mediaDemoOutcome}：本批次没有触发权限失败；${resultText}。`);
      setMediaDemoRunning(false);
      toast.info("仅完成本地演示，未执行上传或写入台账。");
    }, 220);
  };
  const prepareMedia = async () => {
    const prepare = api.media?.prepare;
    if (!mediaCapability.available || !prepare || mediaRunBusy || selectedRows.length === 0) return;
    const projectId = id;
    const skus = selectedRows.map((row) => row.sku);
    const activation = edmMediaJobMonitor.begin(projectId, project?.name ?? projectId, skus);
    try {
      const run = await prepare({ project: projectId, skus });
      edmMediaJobMonitor.associate(activation, run.runId);
    } catch (cause) {
      edmMediaJobMonitor.fail(activation, apiErrorMessage(cause, "图片处理任务启动失败。"));
    }
  };
  if (projectQuery.isLoading) return <div className="si-page-loading" role="status">正在加载项目信息…</div>;
  if (projectQuery.isError || !project) return <ApiErrorNotice page label="项目 EDM 页面加载失败。" error={projectQuery.error} onRetry={() => void projectQuery.refetch()} />;

  return <div className="si-page si-edm-page">
    <ProjectHeader project={project} activeTab="edm" hasTabPanel actions={<><Button onClick={() => void openProjectFolder()}>打开项目文件夹</Button><Button onClick={() => void copyCommand()}><Copy size={14} />复制 edm-builder 指令</Button></>} />
    <ProjectTabPanel projectId={project.id} tab="edm">
    <div className="si-edm-kpis">{summaryQuery.isLoading ? <div className="si-query-loading" role="status">正在加载 EDM 概览…</div> : summaryQuery.isError || !summary ? <ApiErrorNotice label="EDM 概览加载失败。" error={summaryQuery.error} onRetry={() => void summaryQuery.refetch()} /> : metrics.map((metric) => <KpiCard key={metric.key} metric={metric} />)}</div>
    {!isMockApi && <div className="si-edm-live-workflows">
      {exportCapability.available ? <div className="si-edm-export-control">
        <Button variant="primary" disabled={exportMutation.isPending || exportSafetyBlocked} onClick={startExport}>
          {exportMutation.isPending ? "正在生成全项目清单…" : "导出全项目 SKU 清单"}
        </Button>
        {exportSafetyBlocked && !exportMutation.isPending && exportSafetyState === "blocked" && <Notice tone="warn" title="导出操作已暂停">
          上次操作可能中断或写入结果未知，清单可能已经生成。请先核对生成标记、当前内容与预期输出；在后端提供并验证每次调用前的完整核验前，此页不会重新发送导出请求。
        </Notice>}
        {(exportSafetyState === "unavailable" || exportSafetyUnavailableProjectId === id) && <Notice tone="warn" title="无法记录导出确认状态">
          本机存储不可用，导出请求不会发送。请恢复应用本地存储后重新进入此页；本地状态恢复后可重新尝试。
        </Notice>}
        {currentExportFeedback && "result" in currentExportFeedback && <Notice tone={currentExportFeedback.safetyWarning ? "warn" : "info"} title="EDM SKU 清单导出结果">
          {exportResultMessage(currentExportFeedback.result)} 路径：<code>{currentExportFeedback.result.path}</code>{currentExportFeedback.safetyWarning && <> {currentExportFeedback.safetyWarning}</>}
        </Notice>}
        {currentExportFeedback && "error" in currentExportFeedback && <Notice tone={currentExportFeedback.error.tone} title={exportSafetyUnavailableProjectId === id ? "导出请求未发送" : currentExportFeedback.error.tone === "warn" ? "导出结果尚未确认" : "清单导出失败"}>
          {currentExportFeedback.error.message}
        </Notice>}
      </div> : <Notice tone="info" title="全项目 SKU 清单导出尚未就绪">
        Core 与 Desktop IPC 未同时提供并开放 `edm.exportIndex` 前，不显示可执行的导出操作。
      </Notice>}
      {mediaDisplaySelection.kind === "loading" && <div className="si-query-loading" role="status">正在核对最近 {EDM_MEDIA_HISTORY_LIMIT} 条任务记录（包含所有任务类型）…</div>}
      {mediaHistoryQuery.isError && !mediaSnapshotActive && <ApiErrorNotice label="最近 100 条任务记录加载失败，无法核对最新媒体任务。" error={mediaHistoryQuery.error} onRetry={() => void mediaHistoryQuery.refetch()} />}
      {mediaDisplaySelection.kind === "history" && <MediaHistoryRecovery run={mediaDisplaySelection.run} stale={mediaHistoryQuery.isError} />}
      {mediaDisplaySelection.kind === "history" && mediaRunSnapshot?.state === "failed" && !mediaRunSnapshot.runId && <Notice tone="error" title="最近一次图片任务启动失败">{mediaRunSnapshot.error ?? "任务未能启动。"}</Notice>}
      {mediaDisplaySelection.kind === "empty" && <Notice tone="info" title="最近任务记录中没有媒体任务">最近 100 条任务记录（包含所有任务类型）没有媒体任务；更早的记录不在本次查询范围内。</Notice>}
      {mediaDisplaySelection.kind === "history-truncated" && <Notice tone="warn" title="无法确认最近媒体任务">
        页面保留的媒体快照早于最近 100 条任务记录范围；为避免显示过期结果，此处不展示它。请在运行页查找更早记录。
      </Notice>}
    </div>}
    {isMockApi ? <div className="si-edm-media-demo">
      <Button type="button" variant="ghost" size="small" className="si-edm-media-demo-toggle" aria-expanded={mediaDemoOpen} aria-controls="si-edm-media-demo-panel" onClick={() => setMediaDemoOpen((open) => !open)}>交互模拟（仅本地演示，不会上传或写入台账）</Button>
      <div id="si-edm-media-demo-panel" className="si-edm-media-demo-panel" hidden={!mediaDemoOpen}>
      <Notice tone="info" title="不会上传，也不会写入项目台账。">选择表格行后可预览逐 SKU 结果；该演示不调用 media.prepare、Job 或外部服务。</Notice>
      <div className="si-edm-media-demo-actions">
        <Select ariaLabel="模拟媒体准备结果" value={mediaDemoOutcome} onValueChange={(value) => setMediaDemoOutcome(value === "WP_AUTH_FAILED" || value === "WP_FORBIDDEN" ? value : "complete")} options={[
          { value: "complete", label: "正常结果示例" },
          { value: "WP_AUTH_FAILED", label: "401 认证失败并停批" },
          { value: "WP_FORBIDDEN", label: "403 权限不足并停批" },
        ]} />
        <Button variant="primary" disabled={selectedRows.length === 0 || mediaDemoRunning} onClick={simulateMediaPreparation}>{mediaDemoRunning ? "模拟处理中…" : `模拟获取图片 URL（${selectedRows.length}）`}</Button>
      </div>
      {mediaDemoRunning && <p role="status">模拟批次正在排队处理选中 SKU…</p>}
      {mediaDemoMessage && <Notice tone={mediaDemoOutcome === "complete" ? "info" : "warn"} title="模拟批次结果">{mediaDemoMessage}</Notice>}
      {selectedRows.some((row) => mediaDemoStatuses[row.sku]) && <ul className="si-edm-media-demo-results" aria-label="模拟逐 SKU 结果">
        {selectedRows.filter((row) => mediaDemoStatuses[row.sku]).map((row) => {
          const state = mediaDemoStatuses[row.sku]!;
          return <li key={row.sku}><code>{row.sku}</code><Chip tone={mediaStatusTones[state.status]}>{mediaStatusLabels[state.status]}（模拟）</Chip>{state.reason && <small>{state.reason}</small>}</li>;
        })}
      </ul>}
      <EdmWorkflowPrototype key={id} projectName={project.name} projectSkuCount={summary?.total ?? 0} selectedSkus={selectedRows.map((row) => row.sku)} />
      </div>
    </div> : mediaCapability.available ? <div className="si-edm-media-demo">
      <Notice tone="info" title="图片 URL 准备将由 Core 逐 SKU 处理。">已选择 {selectedRows.length} 个 SKU；台账已有 URL、Feed JPG/PNG 及其他图片格式会按 Core 返回的逐 SKU 结果显示。</Notice>
      <div className="si-edm-media-demo-actions">
        <Button variant="primary" disabled={selectedRows.length === 0 || mediaRunBusy} onClick={() => void prepareMedia()}>{mediaRunBusy ? "图片处理中…" : `获取图片 URL（${selectedRows.length}）`}</Button>
      </div>
      {mediaRunProgress && <p role="status">{mediaRunProgress}</p>}
      {mediaRunMessage && <Notice tone={mediaRunTone} title="图片准备任务结果">{mediaRunMessage}</Notice>}
      {Object.keys(mediaRunStatuses).length > 0 && <ul className="si-edm-media-demo-results" aria-label="图片准备逐 SKU 结果">
        {Object.entries(mediaRunStatuses).map(([sku, state]) => {
          return <li key={sku}><code>{sku}</code><Chip tone={mediaStatusTones[state.status]}>{mediaStatusLabels[state.status]}</Chip>{state.reason && <small>{state.reason}</small>}</li>;
        })}
      </ul>}
    </div> : <Notice tone="warn" title="图片 URL 准备尚未就绪">{mediaCapability.message} 既有 URL 编辑与保存功能仍可使用。</Notice>}
    {listQuery.isLoading ? <div className="si-query-loading" role="status">正在加载 SKU 图片…</div> : listQuery.isError ? <ApiErrorNotice label="SKU 图片列表加载失败。" error={listQuery.error} onRetry={() => void listQuery.refetch()} /> : <DataTable
      tableId="edm.images" rows={listQuery.data?.rows ?? []} total={listQuery.data?.total ?? 0} columns={columns}
      query={query} onQueryChange={setQuery} onRowClick={setSelected} getRowId={(row) => row.sku} height="fill" rowHeight={48}
      selectable={isMockApi || mediaCapability.available} onSelectionChange={isMockApi || mediaCapability.available ? setSelectedRows : undefined}
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
