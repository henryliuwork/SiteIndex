import { useState } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { RefreshCw } from "lucide-react";
import type { ProjectSummary, RunLog, ScheduleState, SystemTaskRow } from "@siteindex/shared";
import { api, apiErrorMessage } from "../api";
import { projectQueryKeys } from "../project-queries";
import { ApiErrorNotice, Button, Card, Chip, DataTable, EmptyState, formatDateTime, Notice, PageHeader, Select, useToast } from "../components";
import type { ColumnDef } from "@tanstack/react-table";
import "./schedules/page.css";

type ScheduleVerification = {
  state: "ok" | "unregistered" | "path_mismatch" | "orphaned" | "error";
  message?: string;
  repaired?: boolean;
};

type ScheduleProjectRow = {
  project: ProjectSummary;
  schedule?: ScheduleState;
  scheduleError?: unknown;
  refetchSchedule?: () => void;
  lastRun?: RunLog;
  historyError?: unknown;
  historyLoading: boolean;
};

const jobLabels: Record<string, string> = {
  daily: "每日同步",
  validate: "数据校验",
  weekly: "每周抓取",
  readme: "刷新 README",
  monthly: "每月归档",
  "index-check": "检查收录",
  views: "更新视图",
};

function nextRun(schedule: ScheduleState): { job: string; at: string } | null {
  const next = schedule.next_runs
    .filter((run): run is typeof run & { at: string } => Boolean(run.at))
    .sort((left, right) => left.at.localeCompare(right.at))[0];
  return next ? { job: jobLabels[next.job] ?? next.job, at: next.at } : null;
}

function runStatus(run: RunLog): { label: string; tone: "ok" | "warn" | "danger" | "neutral" } {
  if (run.status === "ok") return { label: "成功", tone: "ok" };
  if (run.status === "partial") return { label: "部分完成", tone: "warn" };
  if (run.status === "failed") return { label: "失败", tone: "danger" };
  return { label: "已跳过", tone: "neutral" };
}

function ScheduleCadence({ enabled, time }: { enabled: boolean; time: string }) {
  return <div className="si-schedule-cadence">
    <Chip tone={enabled ? "ok" : "neutral"}>{enabled ? "已启用" : "已停用"}</Chip>
    <time>{time}</time>
  </div>;
}

type ScheduleVerificationUiState = {
  result: ScheduleVerification | null;
  checking: boolean;
  error: string;
};

function ScheduleStatusCell({ project, registered, verification, canVerify, onVerify }: {
  project: ProjectSummary;
  registered: boolean;
  verification?: ScheduleVerificationUiState;
  canVerify: boolean;
  onVerify: (projectId: string, repair?: boolean) => void;
}) {
  const result = verification?.result ?? null;
  const checking = verification?.checking ?? false;
  const error = verification?.error ?? "";
  const state = result?.state ?? (registered ? "ok" : "unregistered");
  const status = state === "ok" ? { label: "已注册", tone: "ok" as const }
    : state === "unregistered" ? { label: "未注册", tone: "warn" as const }
      : state === "path_mismatch" ? { label: "路径不一致", tone: "warn" as const }
        : state === "orphaned" ? { label: "路径不存在", tone: "warn" as const }
          : { label: "校验失败", tone: "danger" as const };

  return <div className="si-schedule-status-cell">
    <Chip tone={status.tone}>{status.label}</Chip>
    {canVerify && <div className="si-schedule-status-actions">
      <Button size="small" disabled={checking} onClick={(event) => { event.stopPropagation(); onVerify(project.id); }}>{checking ? "校验中…" : "校验"}</Button>
      {result?.state === "path_mismatch" && <Button size="small" variant="primary" disabled={checking} onClick={(event) => { event.stopPropagation(); onVerify(project.id, true); }}>{checking ? "修复中…" : "修复"}</Button>}
    </div>}
    {(result?.message || error) && <small className={error || result?.state === "error" ? "si-schedule-status-error" : "si-schedule-status-message"} role={error || result?.state === "error" ? "alert" : "status"}>{error || result?.message}</small>}
  </div>;
}

function SystemTaskStatus(task: SystemTaskRow) {
  if (task.systemState === "Running") return { label: "运行中", tone: "info" as const };
  if (task.systemState === "Disabled") return { label: "已禁用", tone: "warn" as const };
  return { label: "就绪", tone: "ok" as const };
}

function SystemTaskConsistency(task: SystemTaskRow) {
  if (task.configMatches === true) return { label: "与配置一致", tone: "ok" as const };
  if (task.configMatches === false) return { label: "与配置不一致", tone: "warn" as const };
  return { label: "无关联配置", tone: "neutral" as const };
}

function SystemTasksSection({ projects }: { projects: ProjectSummary[] }) {
  const toast = useToast();
  const tasksQuery = useQuery({
    queryKey: ["schedule", "system-tasks"],
    queryFn: () => api.schedule.listSystemTasks!(),
    enabled: typeof api.schedule.listSystemTasks === "function",
    retry: false,
  });
  const refreshTasks = async () => {
    const result = await tasksQuery.refetch();
    result.isError ? toast.error(apiErrorMessage(result.error, "系统计划任务刷新失败。")) : toast.success("系统计划任务已刷新。");
  };
  if (typeof api.schedule.listSystemTasks !== "function") return null;
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));

  return <Card className="si-system-tasks" label="系统计划任务">
    <div className="si-system-tasks-heading">
      <div><h2>系统计划任务</h2><p>只读核对系统中的任务状态及项目计划配置。</p></div>
      <Button size="small" icon={<RefreshCw size={14} aria-hidden="true" />} disabled={tasksQuery.isFetching} onClick={() => void refreshTasks()}>{tasksQuery.isFetching ? "刷新中…" : "刷新"}</Button>
    </div>
    {tasksQuery.isLoading ? <p className="si-schedules-state" role="status">正在读取系统计划任务…</p>
      : tasksQuery.isError ? <ApiErrorNotice label="系统计划任务加载失败。" error={tasksQuery.error} onRetry={() => void tasksQuery.refetch()} />
        : tasksQuery.data?.length ? <ul className="si-system-task-list">{tasksQuery.data.map((task) => {
          const status = SystemTaskStatus(task);
          const consistency = SystemTaskConsistency(task);
          const projectName = task.projectId ? projectNames.get(task.projectId) ?? task.projectId : "未登记项目";
          return <li key={task.taskName} className="si-system-task-row">
            <div className="si-system-task-main">
              <strong>{task.taskName}</strong>
              <span>{projectName} · {jobLabels[task.job] ?? task.job}{task.orphaned ? " · 孤立任务" : ""}</span>
              <small>{task.triggerSummary}</small>
            </div>
            <div className="si-system-task-status"><Chip tone={status.tone}>{status.label}</Chip><span>下次运行：{formatDateTime(task.nextRunAt)}</span></div>
            <div className="si-system-task-consistency"><Chip tone={consistency.tone}>{consistency.label}</Chip>
              {task.differences.length > 0 ? <ul>{task.differences.map((difference, index) => <li key={`${task.taskName}-difference-${index}`}>{difference}</li>)}</ul> : task.configMatches === false ? <small>接口未返回差异说明。</small> : null}
            </div>
          </li>;
        })}</ul> : <EmptyState title="没有系统计划任务">系统计划任务列表为空。</EmptyState>}
  </Card>;
}

function OrphanScheduleTasks() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [cleaningTask, setCleaningTask] = useState<string | null>(null);
  const [cleanupError, setCleanupError] = useState("");
  const orphansQuery = useQuery({
    queryKey: ["schedule", "orphans"],
    queryFn: () => api.schedule.listOrphans!(),
    retry: false,
  });

  const cleanTask = async (taskName: string) => {
    const removeOrphan = api.schedule.removeOrphan;
    if (!removeOrphan || cleaningTask) return;
    setCleaningTask(taskName);
    setCleanupError("");
    try {
      await removeOrphan(taskName);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["schedule", "orphans"] }),
        queryClient.invalidateQueries({ queryKey: ["schedule", "system-tasks"] }),
      ]);
      toast.success("孤立计划任务已清理。");
    } catch (cause) {
      const message = apiErrorMessage(cause, "清理孤立任务失败。");
      setCleanupError(message);
      toast.error(message);
    } finally {
      setCleaningTask(null);
    }
  };

  return <Card className="si-orphan-schedules" label="孤立任务">
    <div className="si-orphan-schedules-heading"><div><h2>孤立任务</h2><p>这些系统计划任务指向已不存在的项目目录。</p></div></div>
    {cleanupError && <Notice tone="error" className="si-schedule-cleanup-error">{cleanupError}</Notice>}
    {orphansQuery.isLoading ? <p className="si-schedules-state" role="status">正在读取孤立任务…</p>
      : orphansQuery.isError ? <ApiErrorNotice label="孤立任务加载失败。" error={orphansQuery.error} onRetry={() => void orphansQuery.refetch()} />
        : (orphansQuery.data?.length ?? 0) === 0 ? <EmptyState title="没有孤立任务">当前没有指向已删除项目目录的计划任务。</EmptyState>
          : <ul className="si-orphan-schedule-list">{orphansQuery.data!.map((task) => <li key={task.taskName}>
            <div><strong>{task.taskName}</strong><code>{task.path}</code><span>{task.reason}</span></div>
            {api.schedule.removeOrphan && <Button size="small" disabled={cleaningTask !== null} onClick={() => void cleanTask(task.taskName)}>{cleaningTask === task.taskName ? "清理中…" : "清理"}</Button>}
          </li>)}</ul>}
  </Card>;
}

export function SchedulesPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [selectedProject, setSelectedProject] = useState("all");
  const [query, setQuery] = useState({ page: 1, pageSize: 50 });
  const [verificationByProject, setVerificationByProject] = useState<Record<string, ScheduleVerificationUiState>>({});
  const projectsQuery = useQuery({ queryKey: projectQueryKeys.list, queryFn: () => api.projects.list() });
  const projects = projectsQuery.data ?? [];
  const scheduleQueries = useQueries({ queries: projects.map((project) => ({
    queryKey: ["schedule", project.id],
    queryFn: () => api.schedule.get(project.id),
    retry: false,
  })) });
  const historyQueries = useQueries({ queries: projects.map((project) => ({
    queryKey: ["runs", project.id, "recent"],
    queryFn: () => api.jobs.history(project.id, 1),
    retry: false,
  })) });
  const runtimeStatusQuery = useQuery({
    queryKey: ["schedule", "runtime-status"],
    queryFn: () => api.schedule.status ? api.schedule.status() : Promise.resolve(null),
    enabled: Boolean(api.schedule.status),
    retry: false,
  });
  const runVerification = async (projectId: string, repair = false) => {
    const verify = api.schedule.verify;
    if (!verify || verificationByProject[projectId]?.checking) return;
    setVerificationByProject((current) => ({
      ...current,
      [projectId]: { ...current[projectId], result: current[projectId]?.result ?? null, checking: true, error: "" },
    }));
    try {
      const result = await verify(projectId, repair ? { repair: true } : undefined);
      setVerificationByProject((current) => ({
        ...current,
        [projectId]: { result, checking: false, error: "" },
      }));
      if (repair && result.state === "ok") {
        await queryClient.invalidateQueries({ queryKey: ["schedule", projectId] });
      }
      if (result.state === "ok") toast.success(repair ? "系统计划任务已修复。" : "计划任务校验通过。");
      else toast.info(result.message ?? (repair ? "计划任务修复未完成。" : "计划任务校验发现路径或注册状态不一致。"));
    } catch (cause) {
      const message = apiErrorMessage(cause, "计划任务校验失败。");
      setVerificationByProject((current) => ({
        ...current,
        [projectId]: {
          result: current[projectId]?.result ?? null,
          checking: false,
          error: message,
        },
      }));
      toast.error(message);
    }
  };
  const visibleProjects = selectedProject === "all" ? projects : projects.filter((project) => project.id === selectedProject);
  const rows: ScheduleProjectRow[] = visibleProjects.map((project) => {
    const projectIndex = projects.findIndex((candidate) => candidate.id === project.id);
    const scheduleQuery = scheduleQueries[projectIndex];
    const historyQuery = historyQueries[projectIndex];
    return {
      project,
      schedule: scheduleQuery?.data,
      scheduleError: scheduleQuery?.error,
      refetchSchedule: scheduleQuery ? () => { void scheduleQuery.refetch(); } : undefined,
      lastRun: historyQuery?.data?.[0],
      historyError: historyQuery?.error,
      historyLoading: Boolean(historyQuery?.isLoading),
    };
  });
  const pageRows = query.pageSize === 0 ? rows : rows.slice((query.page - 1) * query.pageSize, query.page * query.pageSize);
  const mode = runtimeStatusQuery.data?.mode === "system" ? "系统计划任务" : runtimeStatusQuery.data?.mode === "resident" ? "软件常驻（关闭软件后不执行）" : undefined;

  const columns: ColumnDef<ScheduleProjectRow, unknown>[] = [
    { id: "project", accessorFn: (row) => `${row.project.name} ${row.project.domain}`, header: "项目", meta: { width: 144, grow: 0, minWidth: 132, text: "clamp2" }, cell: ({ row }) => <div className="si-schedule-project"><strong>{row.original.project.name}</strong><small>{row.original.project.domain}</small></div> },
    { id: "daily", accessorFn: (row) => row.schedule?.config.daily.time ?? "", header: "每日同步", meta: { width: 124, grow: 0, minWidth: 112, text: "clamp2" }, cell: ({ row }) => row.original.schedule ? <ScheduleCadence enabled={row.original.schedule.config.daily.enabled} time={row.original.schedule.config.daily.time} /> : row.original.scheduleError ? <ApiErrorNotice label="计划读取失败。" error={row.original.scheduleError} onRetry={row.original.refetchSchedule} /> : <span className="si-muted">正在读取…</span> },
    { id: "weekly", accessorFn: (row) => row.schedule?.config.weekly.time ?? "", header: "每周抓取", meta: { width: 124, grow: 0, minWidth: 112, text: "clamp2" }, cell: ({ row }) => row.original.schedule ? <ScheduleCadence enabled={row.original.schedule.config.weekly.enabled} time={row.original.schedule.config.weekly.time} /> : row.original.scheduleError ? <span className="si-muted">—</span> : <span className="si-muted">正在读取…</span> },
    { id: "last_run", accessorFn: (row) => row.lastRun?.finished_at ?? row.lastRun?.started_at ?? "", header: "最近一次运行", meta: { width: 140, grow: 0, minWidth: 128, text: "clamp2" }, cell: ({ row }) => row.original.historyError ? <ApiErrorNotice label="运行记录读取失败。" error={row.original.historyError} /> : row.original.historyLoading ? <span className="si-muted">正在读取…</span> : row.original.lastRun ? <div className="si-schedule-last-run"><Chip tone={runStatus(row.original.lastRun).tone}>{runStatus(row.original.lastRun).label}</Chip><time>{formatDateTime(row.original.lastRun.finished_at ?? row.original.lastRun.started_at)}</time></div> : <span className="si-muted">暂无运行记录</span> },
    { id: "next_run", accessorFn: (row) => row.schedule ? nextRun(row.schedule)?.at ?? "" : "", header: "下一次运行", meta: { width: 160, grow: 1, minWidth: 140, text: "clamp2" }, cell: ({ row }) => row.original.scheduleError ? <span className="si-muted">—</span> : row.original.schedule ? nextRun(row.original.schedule) ? <span>{nextRun(row.original.schedule)!.job} · {formatDateTime(nextRun(row.original.schedule)!.at)}</span> : <span className="si-muted">暂无计划</span> : <span className="si-muted">正在读取…</span> },
    { id: "system_status", accessorFn: (row) => row.schedule?.registered ? "已注册" : "未注册", header: "系统计划任务", meta: { width: 150, grow: 0, minWidth: 140, text: "clamp2" }, cell: ({ row }) => row.original.scheduleError ? <span className="si-muted">读取失败</span> : row.original.schedule ? <ScheduleStatusCell project={row.original.project} registered={row.original.schedule.registered} verification={verificationByProject[row.original.project.id]} canVerify={typeof api.schedule.verify === "function"} onVerify={(projectId, repair) => { void runVerification(projectId, repair); }} /> : <span className="si-muted">正在读取…</span> },
    { id: "actions", accessorFn: (row) => row.project.id, header: "操作", meta: { width: 92, grow: 0, minWidth: 84, text: "single", sticky: "right", align: "end" }, cell: ({ row }) => <Link className="si-button si-button-small" to={`/p/${row.original.project.id}/runs`}>去配置</Link> },
  ];

  const openProjectRuns = (row: ScheduleProjectRow) => navigate(`/p/${row.project.id}/runs`);
  return <div className="si-page si-schedules-page">
    <PageHeader title="定时任务" meta={mode ? `当前模式：${mode}` : undefined} />
    {runtimeStatusQuery.isError && <Notice tone="error" title="计划任务运行模式读取失败。">{apiErrorMessage(runtimeStatusQuery.error, "请稍后重试。")}</Notice>}
    {projectsQuery.isLoading ? <EmptyState title="正在加载项目计划…">正在读取项目及其计划配置。</EmptyState>
      : projectsQuery.isError ? <ApiErrorNotice page label="项目列表加载失败。" error={projectsQuery.error} onRetry={() => void projectsQuery.refetch()} />
        : projects.length === 0 ? <EmptyState title="还没有项目">添加项目后会在这里汇总计划任务。</EmptyState>
          : <DataTable
            tableId="schedules.projects"
            rows={pageRows}
            total={rows.length}
            columns={columns}
            query={query}
            onQueryChange={(next) => setQuery(next)}
            getRowId={(row) => row.project.id}
            onRowClick={openProjectRuns}
            height="fill"
            rowHeight={52}
            toolbar={<div className="si-schedule-filter"><span>按项目筛选</span><Select ariaLabel="按项目筛选" value={selectedProject} options={[{ value: "all", label: "全部项目" }, ...projects.map((project) => ({ value: project.id, label: project.name }))]} onValueChange={(value) => { setSelectedProject(value); setQuery((current) => ({ ...current, page: 1 })); }} /></div>}
            emptyTitle="没有找到所选项目"
            emptyDescription="请选择其他项目，或改为查看全部项目。"
          />}
    <SystemTasksSection projects={projects} />
    {typeof api.schedule.listOrphans === "function" && <OrphanScheduleTasks />}
  </div>;
}
