import { useState, type KeyboardEvent } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import type { ProjectSummary, RunLog, ScheduleState } from "@siteindex/shared";
import { api } from "../api";
import { projectQueryKeys } from "../project-queries";
import { ApiErrorNotice, Chip } from "../components";
import "./schedules/page.css";

const jobLabels: Record<string, string> = {
  daily: "每日同步",
  validate: "数据校验",
  weekly: "每周抓取",
  readme: "刷新 README",
  monthly: "每月归档",
  "index-check": "检查收录",
  views: "更新视图",
};

function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

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

export function SchedulesPage() {
  const navigate = useNavigate();
  const [selectedProject, setSelectedProject] = useState("all");
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
  const visibleProjects = selectedProject === "all"
    ? projects
    : projects.filter((project) => project.id === selectedProject);

  const openProjectRuns = (project: ProjectSummary) => navigate(`/p/${project.id}/runs`);
  const handleRowKeyDown = (event: KeyboardEvent<HTMLTableRowElement>, project: ProjectSummary) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    openProjectRuns(project);
  };

  return <div className="si-page si-schedules-page">
    <header className="si-schedules-heading">
      <div>
        <h1>定时任务</h1>
        {runtimeStatusQuery.data && <p className="si-schedules-mode">
          当前模式：{runtimeStatusQuery.data.mode === "system" ? "系统计划任务" : "软件常驻（关闭软件后不执行）"}
        </p>}
      </div>
      <label className="si-schedule-filter" htmlFor="si-schedule-project-filter">
        <span>按项目筛选</span>
        <select id="si-schedule-project-filter" value={selectedProject} onChange={(event) => setSelectedProject(event.target.value)}>
          <option value="all">全部项目</option>
          {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
      </label>
    </header>

    {runtimeStatusQuery.isError && <ApiErrorNotice label="计划任务运行模式读取失败。" error={runtimeStatusQuery.error} onRetry={() => void runtimeStatusQuery.refetch()} />}
    {projectsQuery.isLoading ? <p className="si-schedules-state" role="status">正在加载项目计划…</p>
      : projectsQuery.isError ? <ApiErrorNotice page label="项目列表加载失败。" error={projectsQuery.error} onRetry={() => void projectsQuery.refetch()} />
      : projects.length === 0 ? <p className="si-schedules-state" role="status">还没有项目，添加项目后会在这里汇总计划任务。</p>
      : <div className="si-schedules-table-wrap">
        {visibleProjects.length === 0 ? <p className="si-schedules-state" role="status">没有找到所选项目。</p> : <table className="si-schedules-table">
          <thead><tr>
            <th scope="col">项目</th>
            <th scope="col">每日同步</th>
            <th scope="col">每周抓取</th>
            <th scope="col">最近一次运行</th>
            <th scope="col">下一次运行</th>
            <th scope="col">系统计划任务</th>
            <th scope="col"><span className="si-sr-only">操作</span></th>
          </tr></thead>
          <tbody>{visibleProjects.map((project) => {
            const projectIndex = projects.findIndex((candidate) => candidate.id === project.id);
            const scheduleQuery = scheduleQueries[projectIndex];
            const historyQuery = historyQueries[projectIndex];
            const schedule = scheduleQuery?.data;
            const lastRun = historyQuery?.data?.[0];
            const next = schedule ? nextRun(schedule) : null;
            return <tr key={project.id} className="si-schedules-row" tabIndex={0} aria-label={`${project.name}的定时任务，按回车打开配置`} onClick={() => openProjectRuns(project)} onKeyDown={(event) => handleRowKeyDown(event, project)}>
              <th scope="row"><span className="si-schedule-project-name">{project.name}</span><small>{project.domain}</small></th>
              <td>{schedule ? <ScheduleCadence enabled={schedule.config.daily.enabled} time={schedule.config.daily.time} /> : scheduleQuery?.isError ? <ApiErrorNotice label="计划读取失败。" error={scheduleQuery.error} onRetry={() => void scheduleQuery.refetch()} /> : <span className="si-muted">正在读取…</span>}</td>
              <td>{schedule ? <ScheduleCadence enabled={schedule.config.weekly.enabled} time={schedule.config.weekly.time} /> : scheduleQuery?.isError ? <span className="si-muted">—</span> : <span className="si-muted">正在读取…</span>}</td>
              <td>{historyQuery?.isError ? <ApiErrorNotice label="运行记录读取失败。" error={historyQuery.error} onRetry={() => void historyQuery.refetch()} />
                : historyQuery?.isLoading ? <span className="si-muted">正在读取…</span>
                  : lastRun ? <div className="si-schedule-last-run"><Chip tone={runStatus(lastRun).tone}>{runStatus(lastRun).label}</Chip><time>{formatDateTime(lastRun.finished_at ?? lastRun.started_at)}</time></div>
                    : <span className="si-muted">暂无运行记录</span>}</td>
              <td>{scheduleQuery?.isError ? <span className="si-muted">—</span> : next ? <span>{jobLabels[next.job] ?? next.job} · {formatDateTime(next.at)}</span> : schedule ? <span className="si-muted">暂无计划</span> : <span className="si-muted">正在读取…</span>}</td>
              <td>{scheduleQuery?.isError ? <span className="si-muted">读取失败</span> : schedule ? <Chip tone={schedule.registered ? "ok" : "warn"}>{schedule.registered ? "已注册" : "未注册"}</Chip> : <span className="si-muted">正在读取…</span>}</td>
              <td><Link className="si-button si-button-small" to={`/p/${project.id}/runs`} onClick={(event) => event.stopPropagation()}>去配置</Link></td>
            </tr>;
          })}</tbody>
        </table>}
      </div>}
  </div>;
}
