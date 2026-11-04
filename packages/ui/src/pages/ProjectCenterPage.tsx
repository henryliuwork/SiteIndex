import { useMemo, useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import * as Dialog from "@radix-ui/react-dialog";
import { FolderOpen, Plus } from "lucide-react";
import { Link } from "react-router-dom";
import type { Kpi, ListQuery, ProjectSummary, RunLog } from "@siteindex/shared";
import { api, apiErrorMessage } from "../api";
import { invalidateProjectSummary, projectQueryKeys } from "../project-queries";
import { ApiErrorNotice, Button, Chip, DataTable, DetailPanel, KpiCard } from "../components";
import { feedConfigurationStatus, projectWarningAction } from "./project-center/feed-action";

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
  const date = new Date(value);
  const time = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  const today = new Date().toDateString() === date.toDateString();
  return (today ? "今天 " : new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(date) + " ") + time;
}

function formatRunTime(value: string): string {
  const date = new Date(value);
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
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
      <div><dt>开始时间</dt><dd>{new Date(run.started_at).toLocaleString("zh-CN")}</dd></div>
      <div><dt>结束时间</dt><dd>{run.finished_at ? new Date(run.finished_at).toLocaleString("zh-CN") : "仍在运行"}</dd></div>
      <div><dt>执行设备</dt><dd>{run.device_name ?? "本机"}</dd></div>
      <div><dt>结果</dt><dd>{run.status === "ok" ? "成功" : run.status === "partial" ? "部分完成" : run.status === "failed" ? "失败" : "已跳过"}</dd></div>
      {run.errors?.map((error, index) => <div key={index}><dt>错误</dt><dd>{error}</dd></div>)}
    </dl>
  );
}

function ProjectCard({ project, onOpenFolder }: { project: ProjectSummary; onOpenFolder: (path: string) => void }) {
  const detailQuery = useQuery({ queryKey: projectQueryKeys.detail(project.id), queryFn: () => api.projects.get(project.id) });
  const warning = projectWarning(project);
  const feedStatus = feedConfigurationStatus(detailQuery.data?.config.crawl.feed_url);
  const warningAction = projectWarningAction(project, feedStatus);
  const showWarning = warning !== null || warningAction === "feed";
  const warningLines = warning?.lines ?? ["尚未配置有效的商品 Feed。"];
  const chips = [
    ["到货", project.today.restock], ["缺货", project.today.oos], ["调价", project.today.price],
    ["上新", project.today.new], ["移除", project.today.removed],
  ] as const;
  return (
    <article className={"si-project-card" + (showWarning ? " is-warning" : "")}>
      <div className="si-project-card-heading">
        <div className="si-project-heading-copy">
          <Link to={"/p/" + project.id + "/inventory"} className="si-project-title">{project.name}</Link>
          <span className="si-project-domain">{project.domain} · {platformNames[project.platform]}</span>
        </div>
        <Chip tone={warning?.tone ?? (project.sync.state === "ok" ? "ok" : "neutral")}>{statusLabel(project)}</Chip>
      </div>
      {showWarning && <div className={"si-project-warning si-project-warning-" + (warning?.tone ?? "warn")}>
        <div>{warningLines.map((line) => <span key={line}>{line}</span>)}{detailQuery.isError && <small>{apiErrorMessage(detailQuery.error, "暂时无法读取 Feed 配置。")}</small>}</div>
        <div className="si-project-warning-actions">
          {warningAction === "feed" && <Link to={"/p/" + project.id + "/settings/config"}>填写 feed</Link>}
          {warningAction === "runs" && <Link to={"/p/" + project.id + "/runs"}>{project.sync.state === "never" ? "立即同步" : project.sync.state === "failed" || project.sync.state === "partial" ? "查看运行问题" : "查看运行记录"}</Link>}
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
    </article>
  );
}

function AddExistingDialog({ open, onOpenChange, onAdded }: { open: boolean; onOpenChange: (open: boolean) => void; onAdded: (project: ProjectSummary) => void }) {
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
      onAdded(project); onOpenChange(false); setPath("");
    } catch (cause) {
      setError(apiErrorMessage(cause, "添加项目失败，请重试。"));
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
          <Dialog.Description className="si-dialog-description">选择云盘中已经创建的 SiteIndex 项目文件夹。</Dialog.Description>
          <form onSubmit={submit} aria-busy={saving}>
            <label className="si-field-label" htmlFor="existing-project-path">项目文件夹路径</label>
            <input id="existing-project-path" className="si-text-field" autoFocus value={path} disabled={saving} onChange={(event) => setPath(event.target.value)} placeholder="D:\\云盘\\projects\\项目名" />
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

function AttentionDetails({ projects }: { projects: ProjectSummary[] }) {
  const pendingProjects = projects.filter((project) => project.attention > 0);
  return <section id="si-center-attention-panel" className="si-center-attention-panel" aria-label="待处理提醒列表">
    {pendingProjects.length === 0 ? <p role="status">当前没有待处理提醒。</p> : pendingProjects.map((project) => {
      const messages = project.warnings.slice(0, 3);
      return <article className="si-center-attention-item" key={project.id}>
        <div className="si-center-attention-project">
          <strong>{project.name}</strong>
          <Chip tone="warn">{project.attention} 条待处理</Chip>
        </div>
        <ul>{(messages.length > 0 ? messages : ["有待处理事项，请打开项目查看。"]).map((message, index) => <li key={project.id + ":" + index}>{message}</li>)}</ul>
        <Link className="si-button si-button-small" to={"/p/" + project.id + "/seo?status=open"}>去处理</Link>
      </article>;
    })}
  </section>;
}

export function ProjectCenterPage() {
  const queryClient = useQueryClient();
  const projectsQuery = useQuery({ queryKey: projectQueryKeys.list, queryFn: () => api.projects.list() });
  const settingsQuery = useQuery({ queryKey: ["settings"], queryFn: () => api.settings.get() });
  const projects = projectsQuery.data ?? [];
  const primary = projects[0];
  const scheduleQuery = useQuery({ queryKey: ["schedule", primary?.id], queryFn: () => api.schedule.get(primary!.id), enabled: Boolean(primary) });
  const runsQuery = useQuery({ queryKey: ["runs", primary?.id, "recent"], queryFn: () => api.jobs.history(primary!.id, 3), enabled: Boolean(primary) });
  const [addExistingOpen, setAddExistingOpen] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [rootSetupFeedback, setRootSetupFeedback] = useState("");
  const [settingRoot, setSettingRoot] = useState(false);
  const [selectedRun, setSelectedRun] = useState<RunLog | null>(null);
  const [runQuery, setRunQuery] = useState<ListQuery>({ page: 1, pageSize: 20 });
  const [attentionExpanded, setAttentionExpanded] = useState(false);

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
  const nextTime = nextRun?.at ? new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(nextRun.at)) : "—";
  const configuredRoot = settingsQuery.data?.projects_root?.trim();
  const needsRootSetup = settingsQuery.isError || (!settingsQuery.isLoading && !configuredRoot);
  const projectRoot = settingsQuery.isLoading ? "正在读取项目根目录…" : settingsQuery.isError ? "项目根目录读取失败" : configuredRoot ? configuredRoot.replaceAll("/", "\\") : "尚未设置";

  const chooseProjectsRoot = async () => {
    if (settingRoot) return;
    setSettingRoot(true);
    setRootSetupFeedback("");
    try {
      const selected = await api.settings.chooseDirectory(configuredRoot || undefined);
      if (!selected) return;
      const saved = await api.settings.set({ projects_root: selected });
      queryClient.setQueryData(["settings"], saved);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["settings"] }),
        queryClient.invalidateQueries({ queryKey: projectQueryKeys.list, exact: true }),
      ]);
      setRootSetupFeedback("项目根目录已保存。");
    } catch (cause) {
      setRootSetupFeedback("设置项目根目录失败：" + (cause instanceof Error ? cause.message : "请稍后重试"));
    } finally {
      setSettingRoot(false);
    }
  };

  const openFolder = async (path: string) => {
    try { await api.shell.openPath(path); setFeedback("已打开项目文件夹。"); }
    catch (cause) { setFeedback(apiErrorMessage(cause, "打开文件夹失败。")); }
  };
  const handleAdded = async (project: ProjectSummary) => {
    await invalidateProjectSummary(queryClient, project.id);
    setFeedback("已添加项目：" + project.name);
  };

  const metrics: Kpi[] = [
    { key: "projects", label: "项目", value: String(projects.length) },
    { key: "attention", label: "待处理提醒", value: String(totalAttention), tone: totalAttention ? "warn" : "default" },
    { key: "today-oos", label: "今日新缺货 SKU", value: String(newOutOfStock), tone: newOutOfStock ? "danger" : "default", link: primary ? "/p/" + primary.id + "/inventory" : undefined },
    { key: "next-run", label: "下一个定时任务", value: scheduleQuery.isLoading ? "正在读取…" : scheduleQuery.isError ? "读取失败" : nextTime === "—" ? "暂无计划" : nextTime + " · " + (primary?.name ?? ""), hint: nextJob },
  ];

  return (
    <div className="si-page si-project-center">
      <header className="si-page-heading si-center-heading">
        <div>
          <h1>项目中心</h1>
          <p className="si-project-root-line">
            <span>项目根目录 <code>{projectRoot}</code></span>
            {needsRootSetup && <Button size="small" variant="primary" icon={<FolderOpen size={13} />} disabled={settingRoot} onClick={() => void chooseProjectsRoot()}>{settingRoot ? "正在选择…" : "设置项目根目录"}</Button>}
          </p>
          {settingsQuery.isError && <ApiErrorNotice className="si-center-query-error" label="项目根目录读取失败。" error={settingsQuery.error} onRetry={() => void settingsQuery.refetch()} />}
          {rootSetupFeedback && <p className="si-project-root-feedback" role="status">{rootSetupFeedback}</p>}
        </div>
        <div className="si-page-actions">
          <Button icon={<FolderOpen size={15} />} onClick={() => setAddExistingOpen(true)}>添加已有项目</Button>
          <Link className="si-button si-button-primary" to="/new/url"><Plus size={15} />新建项目</Link>
        </div>
      </header>
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
        {attentionExpanded && <AttentionDetails projects={projects} />}
        <section className="si-project-grid" aria-label="项目列表">
          {projects.length === 0 ? <div className="si-project-empty" role="status">
            <FolderOpen size={22} aria-hidden="true" />
            <strong>还没有项目</strong>
            <span>新建项目，或添加云盘中已有的 SiteIndex 项目文件夹。</span>
          </div> : <>
            {projects.map((project) => <ProjectCard key={project.id} project={project} onOpenFolder={(path) => void openFolder(path)} />)}
            <Link className="si-new-project-card" to="/new/url"><Plus size={22} /><strong>新建项目</strong><span>输入网址，3 分钟生成工作区</span></Link>
          </>}
        </section>
        {feedback && <p className="si-feedback" role="status">{feedback}</p>}
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
      <DetailPanel open={Boolean(selectedRun)} onClose={() => setSelectedRun(null)} title="运行详情">
        {selectedRun && <RunDetail run={selectedRun} />}
      </DetailPanel>
    </div>
  );
}
import "./project-center/page.css";
