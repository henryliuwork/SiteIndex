import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import type { JobName, JobProgress, JobResult, ListQuery, RunLog, RunnerState, ScheduleConfig, ScheduleRuntimeStatus, SchedulableJob, Weekday } from "@siteindex/shared";
import type { ColumnDef } from "@tanstack/react-table";
import { Activity, CalendarClock, CheckCircle2, ClipboardCheck, FileText, Palette, RefreshCw, Square, Wifi } from "lucide-react";
import { api } from "../api";
import { Button, Chip, DataTable, DetailPanel, Tabs } from "../components";
import "./runs/page.css";

const projectTabs = [
  { value: "overview", label: "概览" }, { value: "inventory", label: "库存" }, { value: "products", label: "产品" },
  { value: "seo", label: "SEO" }, { value: "content", label: "内容" }, { value: "edm", label: "EDM" },
  { value: "design", label: "设计" }, { value: "readme", label: "README" }, { value: "runs", label: "运行" }, { value: "settings", label: "设置" },
] as const;

const jobLabels: Record<JobName, string> = {
  daily: "每日同步", weekly: "每周同步", monthly: "每月同步", validate: "数据校验", readme: "刷新 README", design: "提取设计规范", "index-check": "检查 Google 索引", views: "重建视图",
};
const jobCards: { job: JobName; title: string; description: string; icon: typeof RefreshCw }[] = [
  { job: "daily", title: "每日同步", description: "Feed → SKU、库存、日报、视图", icon: RefreshCw },
  { job: "weekly", title: "每周同步", description: "Sitemap → 页面、博客、分类", icon: Activity },
  { job: "monthly", title: "每月同步", description: "站点概况、设计规范、归档", icon: CalendarClock },
  { job: "design", title: "提取设计规范", description: "用浏览器打开页面提取 tokens", icon: Palette },
  { job: "readme", title: "刷新 README", description: "更新 README 自动区块", icon: FileText },
  { job: "validate", title: "数据校验", description: "逐个校验数据文件与引用", icon: ClipboardCheck },
];
const scheduleItems: { key: SchedulableJob; title: string; hint: string }[] = [
  { key: "daily", title: "每日同步", hint: "feed、库存、日报与视图" },
  { key: "validate", title: "数据校验", hint: "检查数据文件与引用" },
  { key: "weekly", title: "每周同步（页面 / 博客 / SEO）", hint: "Sitemap 页面、内容与分类" },
  { key: "readme", title: "刷新 README", hint: "更新自动区块" },
  { key: "monthly", title: "每月同步（站点概况 / 设计规范）", hint: "生成月度归档" },
];
const weekdays: { value: Weekday; label: string }[] = [
  { value: 1, label: "一" }, { value: 2, label: "二" }, { value: 3, label: "三" }, { value: 4, label: "四" },
  { value: 5, label: "五" }, { value: 6, label: "六" }, { value: 7, label: "日" },
];
const optionLabels: { key: keyof ScheduleConfig["options"]; label: string }[] = [
  { key: "wake_to_run", label: "到点唤醒电脑执行" },
  { key: "run_if_missed", label: "错过后开机尽快补跑" },
  { key: "notify_on_failure", label: "失败时发送系统通知" },
  { key: "validate_after_sync", label: "每次同步结束后自动校验写入的文件" },
];

type ActiveRun = { runId: string; job: JobName };
const cloneSchedule = (schedule: ScheduleConfig): ScheduleConfig => JSON.parse(JSON.stringify(schedule)) as ScheduleConfig;

function formatDateTime(value: string | null): string {
  if (!value) return "进行中";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

function runDuration(run: RunLog): string {
  if (!run.finished_at) return "运行中";
  const seconds = Math.max(0, Math.round((new Date(run.finished_at).getTime() - new Date(run.started_at).getTime()) / 1000));
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

function runSummary(run: RunLog): string {
  if (run.errors?.length) return run.errors.join("；");
  const counts = run.counts;
  if (!counts || !Object.keys(counts).length) return run.status === "skipped" ? "未在指定执行设备运行" : run.status === "failed" ? "任务执行失败" : "任务已完成";
  const labels: Record<string, string> = { restock: "补货", out_of_stock: "缺货", price: "调价", new: "上新", removed: "下架", error: "错误", missing: "缺失" };
  return Object.entries(counts).map(([key, count]) => `${labels[key] ?? key} ${count}`).join(" · ");
}

function statusLabel(status: RunLog["status"]): string {
  return status === "ok" ? "成功" : status === "partial" ? "需处理" : status === "failed" ? "失败" : "跳过";
}

function statusTone(status: RunLog["status"]): "ok" | "warn" | "danger" | "neutral" {
  return status === "ok" ? "ok" : status === "partial" ? "warn" : status === "failed" ? "danger" : "neutral";
}

function weekdaySummary(days: Weekday[] | undefined): string {
  const selected = weekdays.filter((day) => days?.includes(day.value)).map((day) => day.label).join("、");
  return selected ? `每周${selected}` : "未选择星期";
}

export function RunsPage() {
  const { id = "kingsyard" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const projectQuery = useQuery({ queryKey: ["projects", id], queryFn: () => api.projects.get(id) });
  const scheduleQuery = useQuery({ queryKey: ["schedule", id], queryFn: () => api.schedule.get(id) });
  const scheduleRuntimeQuery = useQuery({ queryKey: ["schedule-runtime"], queryFn: () => api.schedule.status ? api.schedule.status() : Promise.resolve(null) });
  const runnerQuery = useQuery({ queryKey: ["runner", id], queryFn: () => api.runner.get(id) });
  const historyQuery = useQuery({ queryKey: ["job-history", id], queryFn: () => api.jobs.history(id, 30) });
  const runningQuery = useQuery({ queryKey: ["running-job", id], queryFn: () => api.jobs.running(id), refetchInterval: 1500 });
  const [draft, setDraft] = useState<ScheduleConfig | null>(null);
  const [tableQuery, setTableQuery] = useState<ListQuery>({ page: 1, pageSize: 20 });
  const [activeRun, setActiveRun] = useState<ActiveRun | null>(null);
  const [progress, setProgress] = useState<JobProgress | null>(null);
  const [runResult, setRunResult] = useState<JobResult | null>(null);
  const [logs, setLogs] = useState<JobProgress[]>([]);
  const [selectedRun, setSelectedRun] = useState<RunLog | null>(null);
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [reauthorizingSchedule, setReauthorizingSchedule] = useState(false);
  const [claimingRunner, setClaimingRunner] = useState(false);
  const [startingJob, setStartingJob] = useState(false);
  const [feedback, setFeedback] = useState("");
  const initializedRun = useRef(false);

  useEffect(() => { if (scheduleQuery.data) setDraft(cloneSchedule(scheduleQuery.data.config)); }, [scheduleQuery.data]);
  useEffect(() => {
    if (initializedRun.current || !runningQuery.isSuccess) return;
    initializedRun.current = true;
    const running = runningQuery.data;
    if (running) setActiveRun({ runId: running.runId, job: running.job as JobName });
  }, [runningQuery.data, runningQuery.isSuccess]);
  useEffect(() => {
    if (!activeRun) return;
    const stopProgress = api.jobs.onProgress((event) => {
      if (event.runId !== activeRun.runId) return;
      setProgress(event);
      setLogs((current) => [...current, event].slice(-40));
    });
    const stopFinished = api.jobs.onFinished((result) => {
      if (result.runId !== activeRun.runId) return;
      setRunResult(result);
      setActiveRun(null);
      setProgress(null);
      setStartingJob(false);
      setFeedback(result.status === "ok" ? `${jobLabels[result.job]}已完成` : result.summary);
      void queryClient.invalidateQueries({ queryKey: ["job-history", id] });
      void queryClient.invalidateQueries({ queryKey: ["running-job", id] });
    });
    return () => { stopProgress(); stopFinished(); };
  }, [activeRun, id, queryClient]);

  const history = historyQuery.data ?? [];
  const rowColumns: ColumnDef<RunLog, unknown>[] = [
    { id: "time", header: "时间", size: 130, cell: ({ row }) => <code className="si-runs-date">{formatDateTime(row.original.started_at)}</code> },
    { id: "job", header: "任务", size: 130, cell: ({ row }) => <span>{jobLabels[row.original.job]}</span> },
    { id: "device", header: "设备", size: 120, cell: ({ row }) => <span>{row.original.device_name ?? "—"}</span> },
    { id: "summary", header: "结果", size: 370, cell: ({ row }) => <span className="si-runs-summary-cell">{runSummary(row.original)}</span> },
    { id: "status", header: "状态", size: 90, cell: ({ row }) => <Chip tone={statusTone(row.original.status)}>{statusLabel(row.original.status)}</Chip> },
  ];
  const lastByJob = useMemo(() => new Map(history.map((run) => [run.job, run])), [history]);

  const announce = (message: string) => {
    setFeedback(message);
    window.setTimeout(() => setFeedback(""), 3000);
  };

  const startJob = async (job: JobName) => {
    if (!projectQuery.data || activeRun || startingJob) return;
    setStartingJob(true);
    setProgress(null); setRunResult(null); setLogs([]); setFeedback("");
    try {
      const run = await api.jobs.run({ projectPath: projectQuery.data.summary.path, job });
      setActiveRun({ runId: run.runId, job });
      setLogs([{ runId: run.runId, projectPath: projectQuery.data.summary.path, job, pct: 0, step: "启动", level: "info", message: `${jobLabels[job]}已启动`, at: new Date().toISOString() }]);
      setStartingJob(false);
      void queryClient.invalidateQueries({ queryKey: ["running-job", id] });
    } catch (error) {
      setStartingJob(false);
      announce("启动失败：" + (error instanceof Error ? error.message : "请稍后重试"));
    }
  };

  const stopJob = async () => {
    if (!activeRun) return;
    try { await api.jobs.cancel(activeRun.runId); announce("已发送停止请求"); }
    catch (error) { announce("停止失败：" + (error instanceof Error ? error.message : "请稍后重试")); }
  };

  const updateScheduleJob = (key: SchedulableJob, patch: Partial<ScheduleConfig[SchedulableJob]>) => {
    setDraft((current) => current ? { ...current, [key]: { ...current[key], ...patch } } : current);
  };

  const toggleWeekday = (key: SchedulableJob, day: Weekday) => {
    if (!draft || key === "monthly") return;
    const days = draft[key].days ?? [];
    const next = days.includes(day) ? days.filter((value) => value !== day) : [...days, day].sort((a, b) => a - b);
    updateScheduleJob(key, { days: next });
  };

  const saveSchedule = async () => {
    if (!draft || savingSchedule) return;
    if (draft.monthly.day_of_month == null || draft.monthly.day_of_month < 1 || draft.monthly.day_of_month > 31) { announce("每月日期须在 1 到 31 之间"); return; }
    setSavingSchedule(true);
    try {
      const saved = await api.schedule.save(id, draft);
      queryClient.setQueryData(["schedule", id], saved);
      setDraft(cloneSchedule(saved.config));
      announce("计划已保存，系统任务计划已更新");
    } catch (error) { announce("保存失败：" + (error instanceof Error ? error.message : "请稍后重试")); }
    finally { setSavingSchedule(false); }
  };

  const reauthorizeSchedule = async () => {
    if (!api.schedule.reauthorize || reauthorizingSchedule) return;
    setReauthorizingSchedule(true);
    try {
      const status = await api.schedule.reauthorize();
      queryClient.setQueryData<ScheduleRuntimeStatus>(["schedule-runtime"], status);
      announce(status.authorization_required ? "授权尚未完成，请在系统提示中完成授权后重试" : "已重新授权注册");
    } catch (error) {
      announce("重新授权失败：" + (error instanceof Error ? error.message : "请稍后重试"));
    } finally {
      setReauthorizingSchedule(false);
    }
  };

  const claimRunner = async () => {
    if (claimingRunner) return;
    setClaimingRunner(true);
    try {
      queryClient.setQueryData(["runner", id], await api.runner.claim(id));
      announce("本机已设为此项目的执行设备");
    } catch (error) { announce("设置执行设备失败：" + (error instanceof Error ? error.message : "请稍后重试")); }
    finally { setClaimingRunner(false); }
  };

  if (projectQuery.isError || scheduleQuery.isError || runnerQuery.isError || historyQuery.isError || !projectQuery.data || !scheduleQuery.data || !runnerQuery.data) return <div className="si-page-error" role="alert">运行与计划加载失败。<button type="button" onClick={() => { void projectQuery.refetch(); void scheduleQuery.refetch(); void runnerQuery.refetch(); void historyQuery.refetch(); }}>重试</button></div>;
  if (projectQuery.isLoading || scheduleQuery.isLoading || runnerQuery.isLoading || historyQuery.isLoading || !draft) return <div className="si-page-loading" role="status">正在加载运行与计划…</div>;
  const project = projectQuery.data.summary;
  const scheduleState = scheduleQuery.data;
  const runnerState: RunnerState = runnerQuery.data;
  const currentDevice = runnerState.this_device.device_name;

  return <div className="si-page si-runs-page">
    <header className="si-project-page-heading"><div className="si-project-title-line"><h1>{project.name}</h1><code>{project.domain} · {project.platform}</code></div></header>
    <Tabs value="runs" options={projectTabs} ariaLabel="项目页面" onChange={(value) => navigate(value === "settings" ? `/p/${id}/settings/config` : `/p/${id}${value === "overview" ? "" : "/" + value}`)} />
    {feedback && <p className="si-feedback" role="status">{feedback}</p>}
    <div className="si-runs-layout">
      <main className="si-runs-main">
        <section className="si-runs-job-grid" aria-label="手动运行任务">{jobCards.map(({ job, title, description, icon: Icon }) => {
          const last = lastByJob.get(job);
          return <button type="button" key={job} className="si-run-job-card" disabled={Boolean(activeRun) || startingJob} onClick={() => void startJob(job)}>
            <span className="si-run-job-heading"><strong>{title}</strong><Icon size={16} aria-hidden="true" /></span><span>{description}</span>
            <small>{last ? `上次 ${formatDateTime(last.started_at)} · ${statusLabel(last.status)}` : "尚未运行"}</small>
          </button>;
        })}</section>

        <section className="si-run-console" aria-live="polite">
          <header><div><strong>{activeRun ? jobLabels[activeRun.job] : runResult ? jobLabels[runResult.job] : "运行日志"}</strong>{activeRun ? <Chip tone="info">运行中{progress?.pct == null ? "" : ` · ${progress.pct}%`}</Chip> : runResult ? <Chip tone={runResult.status === "ok" ? "ok" : runResult.status === "failed" ? "danger" : "warn"}>{statusLabel(runResult.status)}</Chip> : <Chip>空闲</Chip>}</div>{activeRun && <Button size="small" onClick={() => void stopJob()} icon={<Square size={12} />}>停止</Button>}</header>
          {activeRun && progress?.pct != null && <div className="si-run-progress"><span style={{ width: `${progress.pct}%` }} /></div>}
          <div className="si-run-log-list">{logs.length ? logs.map((event, index) => <div key={`${event.runId}-${index}`} className={`si-run-log si-run-log-${event.level}`}><code>{new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(event.at))}</code><span>{event.message}</span>{event.step && <small>{event.step}</small>}</div>) : <p>{runResult?.summary ?? "暂无运行中的任务。选择上方任务卡片，查看实时进度与日志。"}</p>}</div>
        </section>

        <section className="si-runs-history"><div className="si-runs-section-heading"><div><h2>运行历史</h2><p>最近 30 次任务执行记录</p></div><Button size="small" onClick={() => void historyQuery.refetch()}>刷新</Button></div>
          <DataTable<RunLog> tableId="runs.history" scopeId={id} rows={history} total={history.length} columns={rowColumns} query={tableQuery} onQueryChange={setTableQuery} onRowClick={setSelectedRun} getRowId={(row) => row.run_id} maxHeight={306} rowHeight={48} showPagination={false} emptyTitle="还没有运行记录" emptyDescription="手动执行或等待定时任务后，记录会显示在这里。" />
        </section>
      </main>

      <aside className="si-runs-side">
        <section className="si-runner-card"><div className="si-runs-section-heading"><h2>执行设备</h2><Chip tone={runnerState.is_this_device ? "ok" : runnerState.runner ? "warn" : "neutral"}>{runnerState.is_this_device ? "本机执行" : runnerState.runner ? "其他设备" : "未指定"}</Chip></div>
          <div className={`si-runner-device${runnerState.is_this_device ? " is-current" : ""}`}><Activity size={17} aria-hidden="true" /><div><strong>{runnerState.runner?.device_name ?? "尚未指定执行设备"}{runnerState.is_this_device ? "（本机）" : ""}</strong><span>{runnerState.runner ? `计划任务只在这台设备上执行 · 设备 ID ${runnerState.runner.device_id}` : "计划任务需要指定一台持续运行的设备"}</span></div></div>
          <p>{runnerState.is_this_device ? "本机正在负责此项目的定时任务。" : runnerState.runner ? "其他设备可通过 SiteIndex 设置改为本机。" : "设置为本机后，此设备会负责执行计划任务。"}</p>
          {!runnerState.is_this_device && <Button size="small" onClick={() => void claimRunner()} disabled={claimingRunner}>{claimingRunner ? "设置中…" : "改为本机"}</Button>}
        </section>

        <section className="si-schedule-card"><div className="si-schedule-heading"><div><h2>定时计划</h2><p>选择每个任务在哪几周几、几点执行；保存后自动更新系统计划任务。</p></div><Chip tone={scheduleState.registered ? "ok" : "warn"}>{scheduleState.registered ? "已注册到任务计划程序" : "尚未注册"}</Chip></div>
          <div className="si-schedule-runtime" aria-live="polite">
            <span>当前模式</span>
            {scheduleRuntimeQuery.isLoading ? <span className="si-schedule-runtime-loading" role="status">正在读取…</span> : scheduleRuntimeQuery.isError ? <span className="si-schedule-runtime-error" role="alert">读取失败</span> : <Chip tone={scheduleRuntimeQuery.data?.mode === "system" ? "ok" : "neutral"}>{scheduleRuntimeQuery.data?.mode === "system" ? "系统计划任务" : scheduleRuntimeQuery.data?.mode === "resident" ? "软件常驻（关闭软件后不执行）" : "运行模式不可用"}</Chip>}
            {scheduleRuntimeQuery.data?.authorization_required && <><span className="si-schedule-auth-hint">需要授权才能注册系统计划任务</span><Button size="small" disabled={!api.schedule.reauthorize || reauthorizingSchedule} onClick={() => void reauthorizeSchedule()}>{reauthorizingSchedule ? "授权中…" : "重新授权注册"}</Button></>}
          </div>
          <div className="si-schedule-jobs">{scheduleItems.map((item) => {
            const jobSchedule = draft[item.key];
            const monthly = item.key === "monthly";
            return <section className="si-schedule-job" key={item.key}>
              <div className="si-schedule-job-heading"><div><strong>{item.title}</strong><small>{item.hint}</small></div><label className="si-schedule-enabled"><input type="checkbox" checked={jobSchedule.enabled} onChange={(event) => updateScheduleJob(item.key, { enabled: event.target.checked })} /><span>启用</span></label></div>
              {!monthly && <div className="si-weekday-picker" role="group" aria-label={`${item.title} 执行星期`}>{weekdays.map((day) => <button type="button" key={day.value} aria-pressed={jobSchedule.days?.includes(day.value) ?? false} className={jobSchedule.days?.includes(day.value) ? "active" : ""} onClick={() => toggleWeekday(item.key, day.value)}>{day.label}</button>)}</div>}
              <div className="si-schedule-time-row">{monthly && <label>每月 <input aria-label="每月几号" type="number" min={1} max={31} value={jobSchedule.day_of_month ?? 1} onChange={(event) => updateScheduleJob(item.key, { day_of_month: Number(event.target.value) })} /> 日</label>}<input aria-label={`${item.title} 执行时间`} type="time" value={jobSchedule.time} onChange={(event) => updateScheduleJob(item.key, { time: event.target.value })} /></div>
              <p>{monthly ? `每月 ${jobSchedule.day_of_month ?? 1} 日 ${jobSchedule.time}` : `${weekdaySummary(jobSchedule.days)} · ${jobSchedule.time}`} · 只在执行设备 {runnerState.runner?.device_name ?? currentDevice} 上运行</p>
            </section>;
          })}</div>
          <div className="si-schedule-options">{optionLabels.map((option) => <label key={option.key}><input type="checkbox" checked={draft.options[option.key]} onChange={(event) => setDraft((current) => current ? { ...current, options: { ...current.options, [option.key]: event.target.checked } } : current)} /><span>{option.label}</span></label>)}</div>
          <div className="si-schedule-actions"><Button variant="primary" disabled={savingSchedule} onClick={() => void saveSchedule()}>{savingSchedule ? "保存中…" : "保存计划"}</Button><span>{scheduleState.next_runs[0]?.at ? `下次：${formatDateTime(scheduleState.next_runs[0].at)}` : "保存后计算下次执行时间"}</span></div>
        </section>
      </aside>
    </div>
    <DetailPanel open={Boolean(selectedRun)} onClose={() => setSelectedRun(null)} title={selectedRun ? `${jobLabels[selectedRun.job]} · ${formatDateTime(selectedRun.started_at)}` : "运行详情"}>{selectedRun && <dl className="si-detail-list"><div><dt>结果</dt><dd><Chip tone={statusTone(selectedRun.status)}>{statusLabel(selectedRun.status)}</Chip></dd></div><div><dt>设备</dt><dd>{selectedRun.device_name ?? "—"}</dd></div><div><dt>触发方式</dt><dd>{selectedRun.trigger === "schedule" ? "定时计划" : selectedRun.trigger === "cli" ? "命令行" : "手动"}</dd></div><div><dt>耗时</dt><dd>{runDuration(selectedRun)}</dd></div><div><dt>摘要</dt><dd>{runSummary(selectedRun)}</dd></div>{selectedRun.errors?.map((error, index) => <div key={index}><dt>问题 {index + 1}</dt><dd>{error}</dd></div>)}</dl>}</DetailPanel>
  </div>;
}
