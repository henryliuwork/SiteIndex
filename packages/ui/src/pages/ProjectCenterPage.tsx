import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import * as Dialog from "@radix-ui/react-dialog";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { FolderOpen, MoreHorizontal, Plus } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import type { CreateWorkspaceOnlyInput, Kpi, ListQuery, ProjectSummary, RunLog, SeoIssue, WorkspaceCreateInput } from "@siteindex/shared";
import { api, apiErrorMessage, isMockApi } from "../api";
import { invalidateProjectSummary, projectQueryKeys } from "../project-queries";
import { ApiErrorNotice, Button, Card, Chip, ConfirmDialog, DataTable, Drawer, EmptyState, formatDateTime, KpiCard, Notice, PageHeader, useToast } from "../components";
import { feedConfigurationStatus, projectWarningAction } from "./project-center/feed-action";
import { WorkspaceImportCheckDialog } from "./project-center/workspace-import-dialog";
import { workspaceDirectoryTree, workspacePathJoin } from "./new-project/workspace-preview";
import { getWorkspaceCapabilities } from "./workspace-capabilities";

type ScheduleVerification = {
  state: "ok" | "unregistered" | "path_mismatch" | "orphaned" | "error";
  message?: string;
  repaired?: boolean;
};

type ScheduleVerificationDisplay = { state: "pending" } | { state: "complete"; result: ScheduleVerification } | { state: "error"; message: string };

const jobNames: Record<string, string> = {
  daily: "每日同步", weekly: "每周同步", monthly: "每月归档", validate: "数据校验",
  readme: "刷新 README", design: "提取设计规范", "index-check": "检查收录", views: "更新视图",
};

const platformNames: Record<ProjectSummary["platform"], string> = {
  magento: "Magento", wordpress: "WordPress", woocommerce: "WooCommerce", shopify: "Shopify", other: "其他平台",
};

function statusLabel(project: ProjectSummary): string {
  if (project.sync.state === "ok") return "同步成功";
  if (project.sync.state === "running") return "同步中";
  if (project.sync.state === "failed") return "同步失败";
  if (project.sync.state === "never") return "待配置";
  return "部分同步";
}

function projectWarning(project: ProjectSummary): { tone: "warn" | "danger"; lines: string[] } | null {
  const lines = [...project.warnings];
  const stale = project.sync.at !== null && Date.now() - new Date(project.sync.at).getTime() > 36 * 60 * 60 * 1000;
  if (stale) lines.unshift("超过 36 小时未同步");
  if (project.sync.state === "failed") lines.unshift("最近一次同步失败");
  if (lines.length === 0 && project.attention === 0 && project.sync.state !== "partial") return null;
  if (lines.length === 0) lines.push("有数据待处理");
  return { tone: project.sync.state === "failed" ? "danger" : "warn", lines };
}

function formatSyncTime(value: string | null): string {
  if (!value) return "尚未同步";
  return formatDateTime(value);
}

function formatRunTime(value: string): string {
  return formatDateTime(value);
}

function runSummary(run: RunLog): string {
  if (run.errors?.length) return run.errors[0] ?? "有错误需要处理";
  const counts = run.counts;
  if (!counts || Object.keys(counts).length === 0) return run.status === "ok" ? "无变化" : "运行已结束";
  const labels: Record<string, string> = { restock: "到货", out_of_stock: "缺货", oos: "缺货", price: "调价", new: "上新", removed: "移除" };
  return Object.entries(counts).slice(0, 4).map(([name, count]) => (name === "restock" ? "+" : name === "out_of_stock" || name === "oos" ? "−" : "") + count + " " + (labels[name] ?? name)).join(" · ");
}

function RunDetail({ run }: { run: RunLog }) {
  return (
    <dl className="si-detail-list">
      <div><dt>任务</dt><dd>{jobNames[run.job] ?? run.job}</dd></div>
      <div><dt>开始时间</dt><dd>{formatDateTime(run.started_at)}</dd></div>
      <div><dt>结束时间</dt><dd>{run.finished_at ? formatDateTime(run.finished_at) : "仍在运行"}</dd></div>
      <div><dt>执行设备</dt><dd>{run.device_name ?? "本机"}</dd></div>
      <div><dt>结果</dt><dd>{run.status === "ok" ? "成功" : run.status === "partial" ? "部分完成" : run.status === "failed" ? "失败" : "已跳过"}</dd></div>
      {run.errors?.map((error, index) => <div key={index}><dt>错误</dt><dd>{error}</dd></div>)}
    </dl>
  );
}

function ProjectActionsMenu({
  project, onRemove, onImportCheck, canRemove, canImportCheck,
}: {
  project: ProjectSummary;
  onRemove: (project: ProjectSummary) => void;
  onImportCheck: (project: ProjectSummary) => void;
  canRemove: boolean;
  canImportCheck: boolean;
}) {
  const [open, setOpen] = useState(false);
  return <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
    <PopoverPrimitive.Trigger asChild>
      <button type="button" className="si-project-more" aria-label={`${project.name}更多操作`} aria-expanded={open} title="更多操作">
        <MoreHorizontal size={17} aria-hidden="true" />
      </button>
    </PopoverPrimitive.Trigger>
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content className="si-popover-content si-project-action-menu" align="end" sideOffset={6}>
        {canImportCheck && <button type="button" className="si-project-menu-action" onClick={() => { setOpen(false); onImportCheck(project); }}>识别并检查工作区</button>}
        {canRemove && <button type="button" className="si-project-menu-action is-danger" onClick={() => { setOpen(false); onRemove(project); }}>移除项目</button>}
        <PopoverPrimitive.Arrow className="si-popover-arrow" />
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  </PopoverPrimitive.Root>;
}

function scheduleVerificationLabel(check: ScheduleVerificationDisplay): string {
  if (check.state === "pending") return "正在校验系统计划任务…";
  if (check.state === "error") return "系统计划任务校验失败：" + check.message;
  const labels: Record<ScheduleVerification["state"], string> = {
    ok: "已注册",
    unregistered: "未注册",
    path_mismatch: "路径不一致",
    orphaned: "路径不存在",
    error: "校验失败",
  };
  return "系统计划任务：" + labels[check.result.state] + (check.result.message ? " · " + check.result.message : "");
}

function ProjectCard({
  project, onOpenFolder, onRemove, onImportCheck, canImportCheck, scheduleVerification,
}: {
  project: ProjectSummary;
  onOpenFolder: (path: string) => void;
  onRemove: (project: ProjectSummary) => void;
  onImportCheck: (project: ProjectSummary) => void;
  canImportCheck: boolean;
  scheduleVerification?: ScheduleVerificationDisplay;
}) {
  const detailQuery = useQuery({ queryKey: projectQueryKeys.detail(project.id), queryFn: () => api.projects.get(project.id) });
  const knownCloudSync = project.storage_location === "known_cloud_sync";
  const warning = projectWarning(project);
  const feedStatus = feedConfigurationStatus(detailQuery.data?.config.crawl.feed_url);
  const warningAction = projectWarningAction(project, feedStatus);
  const showWarning = warning !== null || warningAction === "feed";
  const warningLines = warning?.lines ?? ["尚未配置有效的商品 Feed。"];
  const canImportCheckForProject = canImportCheck && !knownCloudSync;
  const chips = [
    ["到货", project.today.restock], ["缺货", project.today.oos], ["调价", project.today.price],
    ["上新", project.today.new], ["移除", project.today.removed],
  ] as const;
  return (
    <Card className={"si-project-card" + (showWarning ? " is-warning" : "")}>
      <div className="si-project-card-heading">
        <div className="si-project-heading-copy">
          <Link to={"/p/" + project.id + "/inventory"} className="si-project-title">{project.name}</Link>
          <span className="si-project-domain">{project.domain} · {platformNames[project.platform]}</span>
        </div>
        <div className="si-project-card-actions">
          <Chip tone={warning?.tone ?? (project.sync.state === "ok" ? "ok" : "neutral")}>{statusLabel(project)}</Chip>
          {(typeof api.projects.remove === "function" || canImportCheckForProject) && <ProjectActionsMenu
            project={project}
            onRemove={onRemove}
            onImportCheck={onImportCheck}
            canRemove={typeof api.projects.remove === "function"}
            canImportCheck={canImportCheckForProject}
          />}
        </div>
      </div>
      {knownCloudSync && <Notice className="si-project-storage-notice" tone="warn" title="已识别第三方同步目录 · 只读">当前版本仅支持查看。需要继续操作时，请手动复制到本机存储后重新添加；SiteIndex 不会自动迁移或删除项目文件。</Notice>}
      {scheduleVerification && <p className={"si-project-schedule-verification" + (scheduleVerification.state === "error" || (scheduleVerification.state === "complete" && scheduleVerification.result.state === "error") ? " is-error" : "")} role="status">{scheduleVerificationLabel(scheduleVerification)}</p>}
      {showWarning && <div className={"si-project-warning si-project-warning-" + (warning?.tone ?? "warn")}>
        <div>{warningLines.map((line) => <span key={line}>{line}</span>)}{detailQuery.isError && <small>{apiErrorMessage(detailQuery.error, "暂时无法读取 Feed 配置。")}</small>}</div>
        <div className="si-project-warning-actions">
          {warningAction === "feed" && !knownCloudSync && <Link to={"/p/" + project.id + "/settings/config"}>填写 feed</Link>}
          {warningAction === "runs" && !knownCloudSync && <Link to={"/p/" + project.id + "/runs"}>{project.sync.state === "never" ? "立即同步" : project.sync.state === "failed" || project.sync.state === "partial" ? "查看运行问题" : "查看运行记录"}</Link>}
          {warningAction === "project" && <Link to={"/p/" + project.id}>查看项目</Link>}
          <button type="button" onClick={() => onOpenFolder(project.path)}>打开文件夹</button>
        </div>
      </div>}
      {project.sync.state !== "never" && <div className="si-project-stats">
        <div><span>SKU / 产品</span><strong>{project.sku_count.toLocaleString("zh-CN")} / {project.product_count.toLocaleString("zh-CN")}</strong></div>
        <div><span>有货率</span><strong>{project.online_rate === null ? "—" : (project.online_rate * 100).toFixed(1) + "%"}</strong></div>
        <div><span>博客</span><strong>{project.blog_count}</strong></div>
      </div>}
      {project.sync.state !== "never" && <div className="si-project-changes" aria-label="今日库存变化">
        {chips.filter(([, count]) => count > 0).map(([label, count]) => (
          <Chip key={label} tone={label === "缺货" ? "danger" : label === "到货" ? "ok" : "neutral"}>{label}{label === "到货" ? " +" : " "}{count}</Chip>
        ))}
        {chips.every(([, count]) => count === 0) && <span className="si-muted">今日无变化</span>}
      </div>}
      <footer className="si-project-card-footer">
        <span>最近同步 {formatSyncTime(project.sync.at)}</span>
        <span>执行设备 {project.runner_device ?? "—"}</span>
      </footer>
    </Card>
  );
}

function AddExistingDialog({ open, onOpenChange, onAdded }: { open: boolean; onOpenChange: (open: boolean) => void; onAdded: (project: ProjectSummary) => void }) {
  const toast = useToast();
  const [path, setPath] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const submitting = useRef(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting.current) return;
    if (!path.trim()) { setError("请输入项目文件夹路径。"); return; }
    submitting.current = true;
    setSaving(true);
    setError("");
    try {
      const project = await api.projects.addExisting(path.trim());
      onAdded(project);
      toast.success("已添加项目：" + project.name);
      onOpenChange(false); setPath("");
    } catch (cause) {
      const message = apiErrorMessage(cause, "添加项目失败，请重试。");
      setError(message);
      toast.error(message);
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  };
  return (
    <Dialog.Root open={open} onOpenChange={(nextOpen) => {
      if (!nextOpen && submitting.current) return;
      onOpenChange(nextOpen);
    }}>
      <Dialog.Portal>
        <Dialog.Overlay className="si-dialog-overlay" />
        <Dialog.Content className="si-confirm-dialog si-add-project-dialog">
          <Dialog.Title className="si-dialog-title">添加已有项目</Dialog.Title>
          <Dialog.Description className="si-dialog-description">选择本机存储中的 SiteIndex 项目文件夹。未显示同步目录提示不代表路径已验证为本机。</Dialog.Description>
          <form onSubmit={submit} aria-busy={saving}>
            <label className="si-field-label" htmlFor="existing-project-path">项目文件夹路径</label>
            <input id="existing-project-path" className="si-text-field" autoFocus value={path} disabled={saving} onChange={(event) => setPath(event.target.value)} placeholder="D:\\SiteIndex\\projects\\项目名" />
            {error && <p className="si-form-error" role="alert">{error}</p>}
            {saving && <p className="si-muted" role="status" aria-live="polite">正在读取项目…</p>}
            <div className="si-dialog-actions">
              <Button type="button" disabled={saving} onClick={() => onOpenChange(false)}>取消</Button>
              <Button type="submit" variant="primary" disabled={saving}>{saving ? "读取中…" : "添加项目"}</Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function CreateWorkspaceDialog({
  open, onOpenChange, defaultRoot, onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultRoot: string;
  onCreated: (id: string) => void;
}) {
  const toast = useToast();
  const [url, setUrl] = useState("");
  const [brandName, setBrandName] = useState("");
  const [projectsRoot, setProjectsRoot] = useState("");
  const [folderName, setFolderName] = useState("");
  const [markets, setMarkets] = useState("US");
  const [platform, setPlatform] = useState<WorkspaceCreateInput["platform"]>("other");
  const [mailchimp, setMailchimp] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const targetPath = workspacePathJoin(projectsRoot, folderName);
  const submitLock = useRef(false);

  useEffect(() => {
    if (open) {
      setProjectsRoot(defaultRoot);
      setError("");
    }
  }, [open, defaultRoot]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const createWorkspaceOnly = api.projects.createWorkspaceOnly;
    if (!createWorkspaceOnly || submitLock.current) return;
    const cleanUrl = url.trim();
    const cleanRoot = projectsRoot.trim();
    const cleanFolder = folderName.trim();
    const cleanBrand = brandName.trim();
    if (!cleanUrl || !cleanRoot || !cleanFolder || !cleanBrand) {
      setError("请填写网站地址、品牌名、项目根目录和文件夹名。");
      return;
    }
    submitLock.current = true;
    setSaving(true);
    setError("");
    try {
      const normalizedUrl = /^https?:\/\//i.test(cleanUrl) ? cleanUrl : "https://" + cleanUrl;
      const check = api.workspace?.check;
      if (typeof check === "function") {
        const result = await check(workspacePathJoin(cleanRoot, cleanFolder));
        if (!result.ok) {
          const message = result.invalid_entries.length
            ? "目标目录不是空目录：" + result.invalid_entries.slice(0, 10).join("、")
            : "目标目录不是空目录，请选择一个空目录。";
          setError(message);
          toast.error(message);
          return;
        }
      }
      const created = await createWorkspaceOnly({
        url: normalizedUrl,
        brand: { name: cleanBrand },
        markets: markets.split(/[，,]/).map((market) => market.trim()).filter(Boolean),
        projects_root: cleanRoot,
        folder_name: cleanFolder,
        workspace: { enabled: true, platform, esp_presets: mailchimp ? ["mailchimp"] : [] },
      } satisfies CreateWorkspaceOnlyInput);
      onCreated(created.id);
      toast.success("空工作区已创建。");
      onOpenChange(false);
      setUrl(""); setBrandName(""); setFolderName(""); setMarkets("US"); setPlatform("other"); setMailchimp(true);
    } catch (cause) {
      const message = apiErrorMessage(cause, "创建空工作区失败，请重试。");
      setError(message);
      toast.error(message);
    } finally {
      submitLock.current = false;
      setSaving(false);
    }
  };

  return <Dialog.Root open={open} onOpenChange={(nextOpen) => {
    if (saving) return;
    onOpenChange(nextOpen);
  }}>
    <Dialog.Portal>
      <Dialog.Overlay className="si-dialog-overlay" />
      <Dialog.Content className="si-confirm-dialog si-add-project-dialog si-workspace-create-dialog">
        <Dialog.Title className="si-dialog-title">创建空工作区</Dialog.Title>
        <Dialog.Description className="si-dialog-description">生成 Agent 工作区和 SiteIndex 数据目录，不执行抓取任务。</Dialog.Description>
        <form onSubmit={(event) => void submit(event)} aria-busy={saving}>
          <label className="si-field-label" htmlFor="workspace-site-url">网站地址</label>
          <input id="workspace-site-url" className="si-text-field si-mono" value={url} disabled={saving} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com" />
          <label className="si-field-label" htmlFor="workspace-brand-name">品牌名</label>
          <input id="workspace-brand-name" className="si-text-field" value={brandName} disabled={saving} onChange={(event) => setBrandName(event.target.value)} />
          <div className="si-workspace-create-grid">
            <label className="si-field-label" htmlFor="workspace-market">目标市场<input id="workspace-market" className="si-text-field" value={markets} disabled={saving} onChange={(event) => setMarkets(event.target.value)} placeholder="US, CA" /></label>
            <label className="si-field-label" htmlFor="workspace-platform">电商平台<select id="workspace-platform" className="si-text-field" value={platform} disabled={saving} onChange={(event) => setPlatform(event.target.value as WorkspaceCreateInput["platform"])}><option value="magento2">Magento 2</option><option value="woocommerce">WooCommerce</option><option value="shopify">Shopify</option><option value="other">其他平台</option></select></label>
          </div>
          <label className="si-workspace-create-checkbox"><input type="checkbox" checked={mailchimp} disabled={saving} onChange={(event) => setMailchimp(event.target.checked)} />Mailchimp 预设</label>
          <label className="si-field-label" htmlFor="workspace-projects-root">项目根目录</label>
          <div className="si-wizard-directory"><input id="workspace-projects-root" className="si-text-field si-mono" value={projectsRoot} disabled={saving} onChange={(event) => setProjectsRoot(event.target.value)} /><Button type="button" disabled={saving} onClick={async () => {
            try { const selected = await api.settings.chooseDirectory(projectsRoot || undefined); if (selected) { setProjectsRoot(selected); toast.success("项目根目录已选择。"); } }
            catch (cause) { const message = apiErrorMessage(cause, "选择项目根目录失败，请重试。"); setError(message); toast.error(message); }
          }}>选择</Button></div>
          <label className="si-field-label" htmlFor="workspace-folder-name">项目文件夹名</label>
          <input id="workspace-folder-name" className="si-text-field si-mono" value={folderName} disabled={saving} onChange={(event) => setFolderName(event.target.value)} />
          <div className="si-wizard-path"><span>将创建</span><code>{targetPath || "请填写项目根目录和文件夹名"}</code></div>
          {error && <p className="si-form-error" role="alert">{error}</p>}
          <section className="si-workspace-create-preview"><h3>目录预览</h3><pre>{workspaceDirectoryTree(folderName || "[项目文件夹]")}</pre></section>
          <div className="si-dialog-actions"><Button type="button" disabled={saving} onClick={() => onOpenChange(false)}>取消</Button><Button type="submit" variant="primary" disabled={saving}>{saving ? "正在创建…" : "创建空工作区"}</Button></div>
        </form>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}

function CenterStatus({ status }: { status: ProjectSummary["sync"]["state"] }) {
  const tone = status === "failed" ? "danger" : status === "partial" || status === "never" ? "warn" : status === "ok" ? "ok" : "neutral";
  return <Chip tone={tone}>{status === "ok" ? "成功" : status === "failed" ? "失败" : status === "partial" ? "提醒" : status === "running" ? "运行中" : "待配置"}</Chip>;
}

function AttentionKpi({ count, expanded, onToggle }: { count: number; expanded: boolean; onToggle: () => void }) {
  return <button
    type="button"
    className={"si-kpi-card si-center-attention-toggle" + (count > 0 ? " si-kpi-warn" : "")}
    aria-expanded={expanded}
    aria-controls="si-center-attention-panel"
    onClick={onToggle}
  >
    <span className="si-kpi-label">待处理提醒</span>
    <strong className="si-kpi-value">{count}</strong>
    <span className="si-kpi-hint">点击按项目查看提醒</span>
  </button>;
}

function AttentionIssueRow({ project, issue }: { project: ProjectSummary; issue: SeoIssue }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const statusMutation = useMutation({
    mutationFn: (status: "fixed" | "ignored") => {
      if (!api.seo.setIssueStatus) throw new Error("该功能暂不可用。");
      return api.seo.setIssueStatus(project.id, { targets: [{ url: issue.url, rule: issue.rule }], status });
    },
    onSuccess: async (_result, status) => {
      await Promise.all([
        invalidateProjectSummary(queryClient, project.id),
        queryClient.invalidateQueries({ queryKey: ["projects", project.id, "seo", "issues", "open", "recent"], exact: true }),
        queryClient.invalidateQueries({ queryKey: ["seo", "issues", project.id] }),
        queryClient.invalidateQueries({ queryKey: ["seo", "summary", project.id] }),
      ]);
      toast.success(status === "fixed" ? "提醒已标记为已处理。" : "提醒已忽略。");
    },
    onError: (cause) => toast.error(apiErrorMessage(cause, "更新提醒状态失败，请重试。")),
  });
  const canSetStatus = typeof api.seo.setIssueStatus === "function" && project.storage_location !== "known_cloud_sync";

  return <li>
    <div className="si-center-attention-copy"><span>{issue.detail}</span><small>{issue.last_seen}</small></div>
    {canSetStatus && <div className="si-center-attention-actions">
      <Button size="small" disabled={statusMutation.isPending} onClick={() => statusMutation.mutate("fixed")}>已处理</Button>
      <Button size="small" disabled={statusMutation.isPending} onClick={() => statusMutation.mutate("ignored")}>忽略</Button>
    </div>}
    {statusMutation.isError && <small className="si-center-attention-action-error" role="alert">{apiErrorMessage(statusMutation.error, "更新提醒状态失败，请重试。")}</small>}
  </li>;
}

function AttentionDetails({ project }: { project: ProjectSummary }) {
  const issuesQuery = useQuery({
    queryKey: ["projects", project.id, "seo", "issues", "open", "recent"],
    queryFn: () => api.seo.listIssues(project.id, {
      page: 1,
      pageSize: 3,
      sort: { field: "last_seen", dir: "desc" },
      filters: { status: "open" },
    }),
  });
  const issues = issuesQuery.data?.rows ?? [];
  return <article className="si-center-attention-item" key={project.id}>
    <div className="si-center-attention-project">
      <strong>{project.name}</strong>
      <Chip tone="warn">{project.attention} 条待处理</Chip>
    </div>
    {project.storage_location === "known_cloud_sync" && <p className="si-center-attention-readonly" role="note">已识别为第三方同步目录；提醒仅可查看。</p>}
    {issuesQuery.isLoading ? <p className="si-muted" role="status">正在读取最近提醒…</p>
      : issuesQuery.isError ? <ApiErrorNotice className="si-center-attention-error" label="提醒加载失败。" error={issuesQuery.error} onRetry={() => void issuesQuery.refetch()} />
      : issues.length > 0 ? <ul>{issues.map((issue) => <AttentionIssueRow key={project.id + ":" + issue.url + ":" + issue.rule} project={project} issue={issue} />)}</ul>
      : <p className="si-muted" role="status">暂无可展示的待处理提醒。</p>}
    <Link className="si-button si-button-small" to={"/p/" + project.id + "/seo?status=open"}>{project.storage_location === "known_cloud_sync" ? "查看问题" : "去处理"}</Link>
  </article>;
}

function AttentionList({ projects }: { projects: ProjectSummary[] }) {
  const pendingProjects = projects.filter((project) => project.attention > 0);
  return <section id="si-center-attention-panel" className="si-center-attention-panel" aria-label="待处理提醒列表">
    {pendingProjects.length === 0 ? <p role="status">当前没有待处理提醒。</p> : pendingProjects.map((project) => {
      return <AttentionDetails project={project} key={project.id} />;
    })}
  </section>;
}

export function ProjectCenterPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const workspaceCapabilities = getWorkspaceCapabilities(api, isMockApi);
  const projectsQuery = useQuery({ queryKey: projectQueryKeys.list, queryFn: () => api.projects.list() });
  const settingsQuery = useQuery({ queryKey: ["settings"], queryFn: () => api.settings.get() });
  const projects = projectsQuery.data ?? [];
  const primary = projects[0];
  const scheduleQuery = useQuery({ queryKey: ["schedule", primary?.id], queryFn: () => api.schedule.get(primary!.id), enabled: Boolean(primary) });
  const runsQuery = useQuery({ queryKey: ["runs", primary?.id, "recent"], queryFn: () => api.jobs.history(primary!.id, 3), enabled: Boolean(primary) });
  const [addExistingOpen, setAddExistingOpen] = useState(false);
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false);
  const toast = useToast();
  const [settingRoot, setSettingRoot] = useState(false);
  const [selectedRun, setSelectedRun] = useState<RunLog | null>(null);
  const [runQuery, setRunQuery] = useState<ListQuery>({ page: 1, pageSize: 20 });
  const [attentionExpanded, setAttentionExpanded] = useState(false);
  const [projectToRemove, setProjectToRemove] = useState<ProjectSummary | null>(null);
  const [projectForImportCheck, setProjectForImportCheck] = useState<ProjectSummary | null>(null);
  const [removingProject, setRemovingProject] = useState(false);
  const [scheduleVerifications, setScheduleVerifications] = useState<Record<string, ScheduleVerificationDisplay>>({});

  const runColumns = useMemo<ColumnDef<RunLog, unknown>[]>(() => [
    { id: "started_at", accessorKey: "started_at", header: "时间", meta: { width: 140, grow: 0, minWidth: 128, text: "single" }, cell: ({ row }) => <span className="si-mono">{formatRunTime(row.original.started_at)}</span>, enableSorting: true },
    { id: "job", accessorKey: "job", header: "任务", meta: { width: 112, grow: 0, minWidth: 100, text: "single" }, cell: ({ row }) => <span>{jobNames[row.original.job] ?? row.original.job}</span>, enableSorting: true },
    { id: "summary", accessorFn: runSummary, header: "执行摘要", meta: { width: 320, grow: 1, minWidth: 220, text: "single" }, cell: ({ row }) => <span className="si-run-summary">{runSummary(row.original)}</span> },
    { id: "status", accessorKey: "status", header: "状态", meta: { width: 96, grow: 0, minWidth: 88, text: "single" }, cell: ({ row }) => <CenterStatus status={row.original.status === "ok" ? "ok" : row.original.status === "failed" ? "failed" : row.original.status === "partial" ? "partial" : "never"} /> },
  ], []);
  const runs = useMemo(() => {
    const source = [...(runsQuery.data ?? [])];
    if (runQuery.sort) {
      const { field, dir } = runQuery.sort;
      source.sort((a, b) => String((a as unknown as Record<string, unknown>)[field] ?? "").localeCompare(String((b as unknown as Record<string, unknown>)[field] ?? "")) * (dir === "asc" ? 1 : -1));
    }
    return source.slice((runQuery.page - 1) * runQuery.pageSize, runQuery.page * runQuery.pageSize);
  }, [runsQuery.data, runQuery]);

  const totalAttention = projects.reduce((sum, project) => sum + project.attention, 0);
  const newOutOfStock = projects.reduce((sum, project) => sum + project.today.oos, 0);
  const nextRun = scheduleQuery.data?.next_runs[0];
  const nextJob = scheduleQuery.isLoading ? "正在读取计划" : scheduleQuery.isError ? "计划读取失败" : nextRun ? (jobNames[nextRun.job] ?? nextRun.job) : "暂无计划";
  const nextTime = nextRun?.at ? formatDateTime(nextRun.at) : "—";
  const configuredRoot = settingsQuery.data?.projects_root?.trim();
  const needsRootSetup = settingsQuery.isError || (!settingsQuery.isLoading && !configuredRoot);
  const projectRoot = settingsQuery.isLoading ? "正在读取项目根目录…" : settingsQuery.isError ? "项目根目录读取失败" : configuredRoot ? configuredRoot.replaceAll("/", "\\") : "尚未设置";

  const chooseProjectsRoot = async () => {
    if (settingRoot) return;
    setSettingRoot(true);
    try {
      const selected = await api.settings.chooseDirectory(configuredRoot || undefined);
      if (!selected) return;
      const saved = await api.settings.set({ projects_root: selected });
      queryClient.setQueryData(["settings"], saved);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["settings"] }),
        queryClient.invalidateQueries({ queryKey: projectQueryKeys.list, exact: true }),
      ]);
      toast.success("项目根目录已保存。");
    } catch (cause) {
      toast.error("设置项目根目录失败：" + apiErrorMessage(cause, "请稍后重试"));
    } finally {
      setSettingRoot(false);
    }
  };

  const openFolder = async (path: string) => {
    try { await api.shell.openPath(path); toast.success("已打开项目文件夹。"); }
    catch (cause) { toast.error(apiErrorMessage(cause, "打开文件夹失败。")); }
  };
  const handleAdded = async (project: ProjectSummary) => {
    const verify = api.schedule.verify;
    if (verify) {
      setScheduleVerifications((current) => ({ ...current, [project.id]: { state: "pending" } }));
      void verify(project.id).then((result) => {
        setScheduleVerifications((current) => ({ ...current, [project.id]: { state: "complete", result } }));
        toast.success("计划任务校验完成：" + scheduleVerificationLabel({ state: "complete", result }));
      }).catch((cause: unknown) => {
        const message = apiErrorMessage(cause, "校验失败，请稍后重试。");
        setScheduleVerifications((current) => ({ ...current, [project.id]: { state: "error", message } }));
        toast.error(message);
      });
    }
    try { await invalidateProjectSummary(queryClient, project.id); }
    catch (cause) { toast.error(apiErrorMessage(cause, "项目摘要刷新失败，请稍后重试。")); }
  };

  const handleWorkspaceCreated = async (id: string) => {
    setCreateWorkspaceOpen(false);
    try { await invalidateProjectSummary(queryClient, id); }
    catch (cause) { toast.error(apiErrorMessage(cause, "项目摘要刷新失败，请稍后重试。")); }
    navigate("/p/" + id);
  };

  const removeProject = async () => {
    const project = projectToRemove;
    const remove = api.projects.remove;
    if (!project || !remove || removingProject) return;
    setRemovingProject(true);
    try {
      await remove(project.id);
      setProjectToRemove(null);
      await queryClient.invalidateQueries({ queryKey: projectQueryKeys.list, exact: true });
      queryClient.removeQueries({ queryKey: projectQueryKeys.detail(project.id), exact: true });
      queryClient.removeQueries({ queryKey: ["schedule", project.id] });
      queryClient.removeQueries({ queryKey: ["runs", project.id] });
      toast.success("已从项目中心移除：" + project.name);
    } catch (cause) {
      toast.error(apiErrorMessage(cause, "移除项目失败，请重试。"));
    } finally {
      setRemovingProject(false);
    }
  };

  const metrics: Kpi[] = [
    { key: "projects", label: "项目", value: String(projects.length) },
    { key: "attention", label: "待处理提醒", value: String(totalAttention), tone: totalAttention ? "warn" : "default" },
    { key: "today-oos", label: "今日新缺货 SKU", value: String(newOutOfStock), tone: newOutOfStock ? "danger" : "default", link: primary ? "/p/" + primary.id + "/inventory" : undefined },
    { key: "next-run", label: "下一个定时任务", value: scheduleQuery.isLoading ? "正在读取…" : scheduleQuery.isError ? "读取失败" : nextTime === "—" ? "暂无计划" : nextTime + " · " + (primary?.name ?? ""), hint: nextJob },
  ];

  return (
    <div className="si-page si-project-center">
      <PageHeader
        title="项目中心"
        meta={<div className="si-project-root-line"><span>项目根目录 <code>{projectRoot}</code></span>{needsRootSetup && <Button size="small" icon={<FolderOpen size={13} />} disabled={settingRoot} onClick={() => void chooseProjectsRoot()}>{settingRoot ? "正在选择…" : "设置项目根目录"}</Button>}</div>}
        actions={<>
          <Button icon={<FolderOpen size={15} />} onClick={() => setAddExistingOpen(true)}>添加已有项目</Button>
          {workspaceCapabilities.emptyWorkspaceAvailable && <Button icon={<FolderOpen size={15} />} onClick={() => setCreateWorkspaceOpen(true)}>创建空工作区</Button>}
          <Link className="si-button si-button-primary" to="/new/url"><Plus size={15} />新建项目</Link>
        </>}
      />
      <Notice className="si-center-storage-policy" tone="info" title="SiteIndex 仅支持本机存储">第三方同步目录可能无法识别；未显示同步提示不代表路径已验证为本机。需要转移项目时请手动复制文件夹后重新添加，SiteIndex 不会自动迁移或删除项目文件。</Notice>
      {workspaceCapabilities.explainEmptyWorkspaceUnavailable && <Notice tone="info" title="Agent 工作区暂不可用">桌面端尚未接入空工作区创建和目录检查操作；现有项目添加与普通新建流程仍可使用。</Notice>}
      {settingsQuery.isError && <ApiErrorNotice className="si-center-query-error" label="项目根目录读取失败。" error={settingsQuery.error} onRetry={() => void settingsQuery.refetch()} />}
      {projectsQuery.isLoading ? <div className="si-page-loading" role="status">正在加载项目…</div> : projectsQuery.isError ? <ApiErrorNotice page label="项目列表加载失败。" error={projectsQuery.error} onRetry={() => void projectsQuery.refetch()} /> : <>
        <div className="si-center-kpis">
          {metrics.slice(0, 3).map((metric) => metric.key === "attention"
            ? <AttentionKpi key={metric.key} count={totalAttention} expanded={attentionExpanded} onToggle={() => setAttentionExpanded((expanded) => !expanded)} />
            : <KpiCard key={metric.key} metric={metric} />)}
          <div className="si-center-kpi-with-retry">
            <KpiCard metric={metrics[3]!} />
            {scheduleQuery.isError && <ApiErrorNotice className="si-center-query-error" label="定时计划加载失败。" error={scheduleQuery.error} onRetry={() => void scheduleQuery.refetch()} />}
          </div>
        </div>
        {attentionExpanded && <AttentionList projects={projects} />}
        <section className="si-project-grid" aria-label="项目列表">
          {projects.length === 0 ? <div className="si-project-empty"><EmptyState icon={<FolderOpen size={22} />} title="还没有项目">新建项目，或添加本机存储中已有的 SiteIndex 项目文件夹。</EmptyState></div> : <>
            {projects.map((project) => <ProjectCard
              key={project.id}
              project={project}
              onOpenFolder={(path) => void openFolder(path)}
              onRemove={(target) => setProjectToRemove(target)}
              onImportCheck={(target) => setProjectForImportCheck(target)}
              canImportCheck={workspaceCapabilities.importCheckAvailable}
              scheduleVerification={scheduleVerifications[project.id]}
            />)}
            <Link className="si-new-project-card" to="/new/url"><Plus size={22} /><strong>新建项目</strong><span>输入网址，3 分钟生成工作区</span></Link>
          </>}
        </section>
        <section className="si-recent-runs" aria-label="最近运行">
          {runsQuery.isLoading ? <>
            <div className="si-recent-heading"><h2>最近运行</h2><span className="si-muted" role="status">正在读取…</span></div>
            <p className="si-recent-state" role="status">正在加载运行记录…</p>
          </> : runsQuery.isError ? <>
            <div className="si-recent-heading"><h2>最近运行</h2></div>
            <ApiErrorNotice className="si-recent-state" label="运行记录加载失败。" error={runsQuery.error} onRetry={() => void runsQuery.refetch()} />
          </> : runs.length === 0 ? <>
            <div className="si-recent-heading"><h2>最近运行</h2></div>
            <p className="si-recent-state" role="status">暂无运行记录。项目执行同步或校验后，最近运行会显示在这里。</p>
          </> : <DataTable
            tableId="project-center.runs"
            rows={runs}
            total={runsQuery.data?.length ?? 0}
            columns={runColumns}
            query={runQuery}
            onQueryChange={setRunQuery}
            onRowClick={setSelectedRun}
            getRowId={(run) => run.run_id}
            height={138}
            rowHeight={46}
            showHeader={false}
            showPagination={false}
            toolbar={<div className="si-recent-heading">
              <h2>最近运行</h2>
            </div>}
          />}
        </section>
      </>}
      <AddExistingDialog open={addExistingOpen} onOpenChange={setAddExistingOpen} onAdded={(project) => void handleAdded(project)} />
      {workspaceCapabilities.emptyWorkspaceAvailable && <CreateWorkspaceDialog open={createWorkspaceOpen} onOpenChange={setCreateWorkspaceOpen} defaultRoot={configuredRoot ?? ""} onCreated={(id) => void handleWorkspaceCreated(id)} />}
      {workspaceCapabilities.importCheckAvailable && <WorkspaceImportCheckDialog
        open={Boolean(projectForImportCheck)}
        onOpenChange={(open) => { if (!open) setProjectForImportCheck(null); }}
        project={projectForImportCheck}
        available={workspaceCapabilities.importCheckAvailable}
      />}
      <ConfirmDialog
        open={Boolean(projectToRemove)}
        onOpenChange={(open) => { if (!open && !removingProject) setProjectToRemove(null); }}
        title="移除项目？"
        description="仅取消登记，不会删除项目文件夹里的任何文件；同时会注销这个项目的系统计划任务。"
        confirmLabel={removingProject ? "移除中…" : "移除项目"}
        onConfirm={removeProject}
      />
      <Drawer open={Boolean(selectedRun)} onOpenChange={(open) => { if (!open) setSelectedRun(null); }} title="运行详情">
        {selectedRun && <RunDetail run={selectedRun} />}
      </Drawer>
    </div>
  );
}
import "./project-center/page.css";
