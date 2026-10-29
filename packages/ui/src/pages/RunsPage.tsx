import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import type { JobName, JobProgress, JobResult, JobSchedule, RunLog, RunLogStep, RunnerState, ScheduleConfig, ScheduleRuntimeStatus, SchedulableJob, Weekday } from "@siteindex/shared";
import { Activity, CalendarClock, ClipboardCheck, FileText, Palette, Pencil, RefreshCw, Square } from "lucide-react";
import { api, apiErrorMessage } from "../api";
import { invalidateProjectSummary, projectQueryKeys } from "../project-queries";
import { ApiErrorNotice, Button, Chip, ProjectHeader, ProjectTabPanel } from "../components";
import "./runs/page.css";

const jobLabels: Record<string, string> = {
  daily: "每日同步", weekly: "每周同步", monthly: "每月同步", validate: "数据校验", readme: "刷新 README", design: "提取设计规范", "index-check": "检查 Google 索引", views: "重建视图", init: "项目初始化",
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
type ScheduleDraft = JobSchedule;
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

function triggerLabel(trigger: RunLog["trigger"]): string {
  return trigger === "schedule" ? "定时计划" : trigger === "cli" ? "命令行" : "手动执行";
}

function stepLabel(step: string, index: number): string {
  const labels: Record<string, string> = {
    load_project: "读取项目配置", fetch_feed: "读取 Feed", sync_products: "同步产品", sync_inventory: "同步库存",
    generate_report: "生成库存日报", rebuild_views: "重建数据视图", fetch_sitemap: "读取 Sitemap", crawl_pages: "抓取页面",
    classify_content: "识别博客与分类", extract_design: "提取设计规范", validate_files: "校验数据文件", update_readme: "更新 README",
    archive_report: "生成月度归档", check_index: "检查 Google 索引", startup: "启动任务",
  };
  return labels[step] ?? `步骤 ${index + 1}`;
}

function stepStatusLabel(status: RunLogStep["status"]): string {
  return status === "ok" ? "完成" : status === "failed" ? "失败" : "跳过";
}

function stepStatusTone(status: RunLogStep["status"]): "ok" | "danger" | "neutral" {
  return status === "ok" ? "ok" : status === "failed" ? "danger" : "neutral";
}

export function RunsPage() {
  const { id = "kingsyard" } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const projectQuery = useQuery({ queryKey: projectQueryKeys.detail(id), queryFn: () => api.projects.get(id) });
  const scheduleQuery = useQuery({ queryKey: ["schedule", id], queryFn: () => api.schedule.get(id) });
  const scheduleRuntimeQuery = useQuery({ queryKey: ["schedule-runtime"], queryFn: () => api.schedule.status ? api.schedule.status() : Promise.resolve(null) });
  const runnerQuery = useQuery({ queryKey: ["runner", id], queryFn: () => api.runner.get(id) });
  const historyQuery = useQuery({ queryKey: ["job-history", id], queryFn: () => api.jobs.history(id, 30) });
  const runningQuery = useQuery({ queryKey: ["running-job", id], queryFn: () => api.jobs.running(id), refetchInterval: 1500 });
  const [draft, setDraft] = useState<ScheduleConfig | null>(null);
  const [activeRun, setActiveRun] = useState<ActiveRun | null>(null);
  const [progress, setProgress] = useState<JobProgress | null>(null);
  const [runResult, setRunResult] = useState<JobResult | null>(null);
  const [logs, setLogs] = useState<JobProgress[]>([]);
  const [editingScheduleJob, setEditingScheduleJob] = useState<SchedulableJob | null>(null);
  const [scheduleDialogDraft, setScheduleDialogDraft] = useState<ScheduleDraft | null>(null);
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
      announce("启动失败：" + (apiErrorMessage(error, "请稍后重试")));
    }
  };

  const stopJob = async () => {
    if (!activeRun) return;
    try { await api.jobs.cancel(activeRun.runId); announce("已发送停止请求"); }
    catch (error) { announce("停止失败：" + (apiErrorMessage(error, "请稍后重试"))); }
  };

  const openScheduleEditor = (key: SchedulableJob) => {
    if (!draft) return;
    setEditingScheduleJob(key);
    setScheduleDialogDraft({ ...draft[key], days: draft[key].days ? [...draft[key].days] : undefined });
  };

  const updateScheduleDialog = (patch: Partial<ScheduleDraft>) => {
    setScheduleDialogDraft((current) => current ? { ...current, ...patch } : current);
  };

  const toggleScheduleDialogWeekday = (day: Weekday) => {
    if (!scheduleDialogDraft) return;
    const days = scheduleDialogDraft.days ?? [];
    updateScheduleDialog({ days: days.includes(day) ? days.filter((value) => value !== day) : [...days, day].sort((a, b) => a - b) });
  };

  const saveSchedule = async (nextDraft: ScheduleConfig | null = draft): Promise<boolean> => {
    if (!nextDraft || savingSchedule) return false;
    if (nextDraft.monthly.day_of_month == null || nextDraft.monthly.day_of_month < 1 || nextDraft.monthly.day_of_month > 31) { announce("每月日期须在 1 到 31 之间"); return false; }
    setSavingSchedule(true);
    try {
      const saved = await api.schedule.save(id, nextDraft);
      queryClient.setQueryData(["schedule", id], saved);
      setDraft(cloneSchedule(saved.config));
      const runner = queryClient.getQueryData<RunnerState>(["runner", id]);
      void queryClient.invalidateQueries({ queryKey: ["schedule-runtime"] });
      announce(runner && !runner.is_this_device
        ? runner.runner ? `计划已保存，将在执行设备“${runner.runner.device_name}”上运行` : "计划已保存。尚未指定执行设备，点击“改为本机”后才会注册系统计划任务"
        : saved.registered ? "计划已保存，系统计划任务已更新" : "计划已保存，系统计划任务尚未注册，请查看上方运行模式");
      return true;
    } catch (error) { announce("保存失败：" + (apiErrorMessage(error, "请稍后重试"))); return false; }
    finally { setSavingSchedule(false); }
  };

  const saveScheduleFromDialog = async () => {
    if (!draft || !editingScheduleJob || !scheduleDialogDraft) return;
    const next = { ...draft, [editingScheduleJob]: scheduleDialogDraft };
    setDraft(next);
    if (await saveSchedule(next)) { setEditingScheduleJob(null); setScheduleDialogDraft(null); }
  };

  const reauthorizeSchedule = async () => {
    if (!api.schedule.reauthorize || reauthorizingSchedule) return;
    setReauthorizingSchedule(true);
    try {
      const status = await api.schedule.reauthorize();
      queryClient.setQueryData<ScheduleRuntimeStatus>(["schedule-runtime"], status);
      announce(status.authorization_required ? "授权尚未完成，请在系统提示中完成授权后重试" : "已重新授权注册");
    } catch (error) {
      announce("重新授权失败：" + (apiErrorMessage(error, "请稍后重试")));
    } finally {
      setReauthorizingSchedule(false);
    }
  };

  const claimRunner = async () => {
    if (claimingRunner) return;
    setClaimingRunner(true);
    try {
      queryClient.setQueryData(["runner", id], await api.runner.claim(id));
      // 认领后系统计划任务会重新注册，刷新注册状态与运行模式，避免显示旧状态
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["schedule", id] }),
        queryClient.invalidateQueries({ queryKey: ["schedule-runtime"] }),
        invalidateProjectSummary(queryClient, id),
      ]);
      announce("本机已设为此项目的执行设备");
    } catch (error) {
      // 认领可能已写入、只是系统计划任务注册失败，刷新状态以显示真实结果
      void queryClient.invalidateQueries({ queryKey: ["runner", id] });
      void queryClient.invalidateQueries({ queryKey: ["schedule", id] });
      void queryClient.invalidateQueries({ queryKey: ["schedule-runtime"] });
      void invalidateProjectSummary(queryClient, id);
      announce(apiErrorMessage(error, "设置执行设备失败，请稍后重试"));
    }
    finally { setClaimingRunner(false); }
  };

  if (projectQuery.isLoading) return <div className="si-page-loading" role="status">正在加载项目信息…</div>;
  if (projectQuery.isError || !projectQuery.data) return <ApiErrorNotice page label="项目运行页面加载失败。" error={projectQuery.error} onRetry={() => void projectQuery.refetch()} />;
  const project = projectQuery.data.summary;
  const scheduleState = scheduleQuery.data;
  const runnerState: RunnerState | undefined = runnerQuery.data;
  const currentDevice = runnerState?.this_device.device_name ?? "本机";

  return <DialogPrimitive.Root open={Boolean(editingScheduleJob)} onOpenChange={(open) => { if (!open) { setEditingScheduleJob(null); setScheduleDialogDraft(null); } }}>
    <div className="si-page si-runs-page si-runs-page-v2">
      <ProjectHeader project={project} activeTab="runs" hasTabPanel />
      <ProjectTabPanel projectId={project.id} tab="runs">
      {feedback && <p className="si-feedback" role="status">{feedback}</p>}

      <section className="si-runs-block si-runs-execution">
        <div className="si-runs-block-heading"><div><h2>立即执行</h2><p>手动启动任务，查看当前步骤与进度。</p></div>
          <div className="si-runs-device-inline">
            {runnerQuery.isLoading ? <span className="si-muted">正在读取执行设备…</span> : runnerQuery.isError || !runnerState ? <ApiErrorNotice className="si-runs-inline-error" label="执行设备信息加载失败。" error={runnerQuery.error} onRetry={() => void runnerQuery.refetch()} /> : <>
              <Activity size={16} aria-hidden="true" /><span>计划执行设备：<strong>{runnerState.runner?.device_name ?? "尚未指定"}{runnerState.is_this_device ? "（本机）" : ""}</strong></span>
              {!runnerState.is_this_device && <Button size="small" disabled={claimingRunner} onClick={() => void claimRunner()}>{claimingRunner ? "设置中…" : "改为本机"}</Button>}
            </>}
          </div>
        </div>
        <div className="si-runs-job-grid" aria-label="手动运行任务">{jobCards.map(({ job, title, description, icon: Icon }) => {
          const last = lastByJob.get(job);
          return <button type="button" key={job} className="si-run-job-card" disabled={Boolean(activeRun) || startingJob} onClick={() => void startJob(job)}>
            <span className="si-run-job-heading"><strong>{title}</strong><Icon size={16} aria-hidden="true" /></span><span>{description}</span>
            <small>{last ? `上次 ${formatDateTime(last.started_at)} · ${statusLabel(last.status)}` : "尚未运行"}</small>
          </button>;
        })}</div>
        <div className={`si-run-state${activeRun || startingJob ? " is-running" : runResult?.status === "failed" ? " is-failed" : ""}`} aria-live="polite">
          <div className="si-run-state-heading"><div><span className="si-run-state-eyebrow">当前运行状态</span><strong>{activeRun ? jobLabels[activeRun.job] : startingJob ? "正在启动任务…" : runResult ? jobLabels[runResult.job] : "当前没有任务运行"}</strong></div>
            {activeRun || startingJob ? <Chip tone="info">{activeRun ? "运行中" : "启动中"}</Chip> : runResult ? <Chip tone={statusTone(runResult.status)}>{statusLabel(runResult.status)}</Chip> : <Chip tone="neutral">空闲</Chip>}
            {activeRun && <Button size="small" onClick={() => void stopJob()} icon={<Square size={12} />}>停止</Button>}
          </div>
          {activeRun ? <>
            <div className="si-run-state-progress-label"><span>{progress?.step ? `第 ${Math.max(1, [...new Set(logs.map((item) => item.step).filter((step): step is string => Boolean(step) && step !== "启动"))].indexOf(progress.step) + 1)} 步 · ${stepLabel(progress.step, 0)}` : "正在等待步骤进度"}</span><strong>{progress?.pct == null ? "进度计算中" : `${progress.pct}%`}</strong></div>
            <div className={`si-run-state-progress${progress?.pct == null ? " is-indeterminate" : ""}`} role="progressbar" aria-label="任务进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress?.pct ?? undefined}><span style={{ width: progress?.pct == null ? undefined : `${Math.max(0, Math.min(100, progress.pct))}%` }} /></div>
            <p className="si-run-state-message">{progress?.message ?? "任务已启动，正在等待执行设备反馈。"}</p>
          </> : startingJob ? <><div className="si-run-state-progress-label"><span>正在连接执行设备</span><strong>启动中</strong></div><div className="si-run-state-progress is-indeterminate" role="progressbar" aria-label="正在启动任务"><span /></div></> : <p className="si-run-state-message">{runResult?.summary ?? (runningQuery.isError ? "运行状态暂时无法确认。" : "选择上方任务卡片即可立即运行。")}</p>}
          {runningQuery.isError && <ApiErrorNotice className="si-runs-inline-error" label="当前运行状态读取失败。" error={runningQuery.error} onRetry={() => void runningQuery.refetch()} />}
          {logs.length > 0 && <div className="si-run-recent-log">{logs.slice(-3).map((event, index) => <div key={`${event.runId}-${index}`} className={`si-run-log si-run-log-${event.level}`}><code>{new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(event.at))}</code><span>{event.message}</span>{event.step && <small>{stepLabel(event.step, index)}</small>}</div>)}</div>}
        </div>
      </section>

      <section className="si-runs-block si-runs-schedule">
        <div className="si-runs-block-heading"><div><h2>定时计划</h2><p>任务逐项展示下次运行时间；编辑窗口中设置星期和时间并一次保存。</p></div>
          <div className="si-schedule-mode"><span>运行模式</span>{scheduleRuntimeQuery.isLoading ? <span className="si-muted">正在读取…</span> : scheduleRuntimeQuery.isError ? <ApiErrorNotice className="si-schedule-runtime-error" label="运行模式读取失败。" error={scheduleRuntimeQuery.error} onRetry={() => void scheduleRuntimeQuery.refetch()} /> : <Chip tone={scheduleRuntimeQuery.data?.mode === "system" ? "ok" : "neutral"}>{scheduleRuntimeQuery.data?.mode === "system" ? "系统计划任务" : scheduleRuntimeQuery.data?.mode === "resident" ? "软件常驻（关闭后不执行）" : "不可用"}</Chip>}</div>
        </div>
        {scheduleRuntimeQuery.data?.authorization_required && <div className="si-schedule-auth-banner"><span>需要授权才能注册系统计划任务。</span><Button size="small" disabled={!api.schedule.reauthorize || reauthorizingSchedule} onClick={() => void reauthorizeSchedule()}>{reauthorizingSchedule ? "授权中…" : "重新授权注册"}</Button></div>}
        {scheduleQuery.isLoading || (!scheduleQuery.isError && !draft) ? <div className="si-query-loading" role="status">正在加载定时计划…</div> : scheduleQuery.isError || !scheduleState || !draft ? <ApiErrorNotice label="定时计划加载失败。" error={scheduleQuery.error} onRetry={() => void scheduleQuery.refetch()} /> : <>
          <div className="si-schedule-plan-status"><Chip tone={scheduleState.registered ? "ok" : "warn"}>{scheduleState.registered ? "已注册到任务计划程序" : "尚未注册"}</Chip><span>执行设备：{runnerState?.runner?.device_name ?? currentDevice}</span></div>
          <div className="si-schedule-rows">{scheduleItems.map((item) => {
            const jobSchedule = draft[item.key];
            const monthly = item.key === "monthly";
            const nextRun = scheduleState.next_runs.find((run) => run.job === item.key)?.at ?? null;
            return <article className="si-schedule-row" key={item.key}>
              <div className="si-schedule-row-title"><strong>{item.title}</strong><small>{item.hint}</small></div>
              <div className="si-schedule-row-meta"><Chip tone={jobSchedule.enabled ? "ok" : "neutral"}>{jobSchedule.enabled ? "已启用" : "已停用"}</Chip><span>{monthly ? `每月 ${jobSchedule.day_of_month ?? 1} 日 ${jobSchedule.time}` : `${weekdaySummary(jobSchedule.days)} · ${jobSchedule.time}`}</span><span>下次：{jobSchedule.enabled ? nextRun ? formatDateTime(nextRun) : "等待计算" : "—"}</span></div>
              <Button size="small" icon={<Pencil size={13} />} onClick={() => openScheduleEditor(item.key)}>编辑</Button>
            </article>;
          })}</div>
          <details className="si-schedule-options-details"><summary>高级计划选项</summary><div className="si-schedule-options">{optionLabels.map((option) => <label key={option.key}><input type="checkbox" checked={draft.options[option.key]} onChange={(event) => setDraft((current) => current ? { ...current, options: { ...current.options, [option.key]: event.target.checked } } : current)} /><span>{option.label}</span></label>)}</div><div className="si-schedule-actions"><Button variant="primary" disabled={savingSchedule} onClick={() => void saveSchedule()}>{savingSchedule ? "保存中…" : "保存计划"}</Button></div></details>
        </>}
      </section>

      <section className="si-runs-block si-runs-history">
        <div className="si-runs-block-heading"><div><h2>运行历史</h2><p>最近 30 次任务执行记录；展开记录查看步骤结果和失败原因。</p></div><Button size="small" onClick={() => void historyQuery.refetch()}>刷新</Button></div>
        {historyQuery.isLoading ? <div className="si-query-loading" role="status">正在加载运行历史…</div> : historyQuery.isError ? <ApiErrorNotice label="运行历史加载失败。" error={historyQuery.error} onRetry={() => void historyQuery.refetch()} /> : history.length ? <div className="si-run-history-list">
          {history.map((run) => <details className="si-run-history-item" key={run.run_id}>
            <summary><span className="si-run-history-time">{formatDateTime(run.started_at)}</span><strong>{jobLabels[run.job]}</strong><span className="si-run-history-trigger">{triggerLabel(run.trigger)}</span><Chip tone={statusTone(run.status)}>{statusLabel(run.status)}</Chip><span className="si-run-history-duration">{runDuration(run)}</span><span className="si-run-history-summary">{runSummary(run)}</span></summary>
            <div className="si-run-history-detail"><div className="si-run-history-context"><span>执行设备：{run.device_name ?? "—"}</span><span>开始：{formatDateTime(run.started_at)}</span><span>结束：{run.finished_at ? formatDateTime(run.finished_at) : "进行中"}</span></div>
              {run.steps?.length ? <ol className="si-run-history-steps">{run.steps.map((step, index) => <li key={`${step.key}-${index}`} className={`is-${step.status}`}><span className="si-run-step-number">{index + 1}</span><div><strong>{stepLabel(step.key, index)}</strong>{step.message && <p>{step.message}</p>}</div><Chip tone={stepStatusTone(step.status)}>{stepStatusLabel(step.status)}</Chip></li>)}</ol> : <p className="si-run-history-empty">这条记录没有返回分步结果。</p>}
              {run.errors?.length ? <div className="si-run-history-errors"><strong>失败原因</strong>{run.errors.map((error, index) => <p key={index}>{error}</p>)}</div> : null}
            </div>
          </details>)}
        </div> : <div className="si-run-history-empty-state"><strong>还没有运行记录</strong><span>手动执行或等待定时任务后，记录会显示在这里。</span></div>}
      </section>
      </ProjectTabPanel>

      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="si-runs-dialog-overlay" />
        <DialogPrimitive.Content className="si-runs-dialog">
          <div className="si-runs-dialog-heading"><DialogPrimitive.Title>{editingScheduleJob ? `编辑${scheduleItems.find((item) => item.key === editingScheduleJob)?.title ?? "任务"}计划` : "编辑计划"}</DialogPrimitive.Title><DialogPrimitive.Close asChild><Button size="small" aria-label="关闭计划编辑">关闭</Button></DialogPrimitive.Close></div>
          <DialogPrimitive.Description>修改完成后保存一次，即更新该项目的计划任务。</DialogPrimitive.Description>
          {editingScheduleJob && scheduleDialogDraft && <>
            <label className="si-schedule-dialog-enabled"><input type="checkbox" checked={scheduleDialogDraft.enabled} onChange={(event) => updateScheduleDialog({ enabled: event.target.checked })} /><span>启用此任务</span></label>
            {editingScheduleJob === "monthly" ? <label className="si-schedule-dialog-month">每月 <input aria-label="每月几号" type="number" min={1} max={31} value={scheduleDialogDraft.day_of_month ?? 1} onChange={(event) => updateScheduleDialog({ day_of_month: Number(event.target.value) })} /> 日</label> : <div className="si-weekday-picker" role="group" aria-label="执行星期">{weekdays.map((day) => <button type="button" key={day.value} aria-pressed={scheduleDialogDraft.days?.includes(day.value) ?? false} className={scheduleDialogDraft.days?.includes(day.value) ? "active" : ""} onClick={() => toggleScheduleDialogWeekday(day.value)}>{day.label}</button>)}</div>}
            <label className="si-schedule-dialog-time">执行时间<input aria-label="执行时间" type="time" value={scheduleDialogDraft.time} onChange={(event) => updateScheduleDialog({ time: event.target.value })} /></label>
          </>}
          <div className="si-runs-dialog-actions"><DialogPrimitive.Close asChild><Button type="button">取消</Button></DialogPrimitive.Close><Button variant="primary" disabled={savingSchedule || !scheduleDialogDraft} onClick={() => void saveScheduleFromDialog()}>{savingSchedule ? "保存中…" : "保存计划"}</Button></div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </div>
  </DialogPrimitive.Root>;
}
