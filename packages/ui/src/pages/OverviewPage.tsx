import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, Clipboard, ExternalLink, FileCheck2, FileText, FolderOpen, RefreshCw } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import type { AttentionItem, OverviewData, ProjectDetail, SyncState } from "@siteindex/shared";
import { api, apiErrorMessage } from "../api";
import { projectQueryKeys } from "../project-queries";
import { ApiErrorNotice, Button, Chip, KpiCard, ProjectHeader, ProjectTabPanel } from "../components";
const syncLabels: Record<SyncState, string> = {
  ok: "同步成功", partial: "部分完成", failed: "同步失败", never: "尚未同步", running: "同步中",
};

function syncLabel(project: ProjectDetail["summary"]): string {
  if (!project.sync.at) return syncLabels[project.sync.state];
  const time = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(project.sync.at));
  return "今天 " + time + " " + syncLabels[project.sync.state];
}

function severityTone(severity: AttentionItem["severity"]): "danger" | "warn" | "neutral" {
  return severity === "high" ? "danger" : severity === "mid" ? "warn" : "neutral";
}

function severityLabel(severity: AttentionItem["severity"]): string {
  return severity === "high" ? "高" : severity === "mid" ? "中" : "低";
}

function projectPath(path: string, file: string): string {
  return path.replace(/[\\/]+$/, "") + (path.includes("\\") ? "\\" : "/") + file;
}

export function OverviewPage() {
  const { id = "kingsyard" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const projectQuery = useQuery({ queryKey: projectQueryKeys.detail(id), queryFn: () => api.projects.get(id) });
  const overviewQuery = useQuery({ queryKey: ["overview", id], queryFn: () => api.overview.get(id) });
  const [feedback, setFeedback] = useState("");
  const [running, setRunning] = useState(false);
  const [syncMessage, setSyncMessage] = useState("");
  const [runId, setRunId] = useState<string | null>(null);

  useEffect(() => {
    setFeedback(""); setSyncMessage(""); setRunId(null); setRunning(false);
  }, [id]);

  useEffect(() => {
    if (!runId) return;
    const unsubscribeProgress = api.jobs.onProgress((progress) => {
      if (progress.runId === runId) setSyncMessage(progress.pct + "% · " + progress.message);
    });
    const unsubscribeFinished = api.jobs.onFinished((result) => {
      if (result.runId !== runId) return;
      setRunId(null); setRunning(false); setSyncMessage("");
      setFeedback(result.status === "ok" ? "每日同步已完成。" : result.summary);
      void queryClient.invalidateQueries({ queryKey: ["overview", id] });
    });
    return () => { unsubscribeProgress(); unsubscribeFinished(); };
  }, [id, queryClient, runId]);

  const project = projectQuery.data;
  const overview: OverviewData | undefined = overviewQuery.data;

  const withFeedback = async (action: () => Promise<void>, success: string) => {
    setFeedback("");
    try { await action(); setFeedback(success); }
    catch (cause) { setFeedback(apiErrorMessage(cause, "操作失败，请重试。")); }
  };

  const copyInstruction = () => withFeedback(() => api.shell.copyText(overview?.agent_instruction ?? ""), "已复制 agent 接入指令。");
  const validateFiles = async () => {
    setFeedback("");
    try {
      const report = await api.files.validate(id);
      const { ok, error, missing } = report.summary;
      setFeedback("校验完成：" + ok + " 个文件通过，" + error + " 个错误，" + missing + " 个缺失。");
    } catch (cause) { setFeedback(apiErrorMessage(cause, "本地数据校验失败。")); }
  };
  const openReadme = () => project && withFeedback(() => api.shell.openPath(projectPath(project.summary.path, "README.md")), "已打开 README。");
  const openProjectFolder = () => project && withFeedback(() => api.shell.openPath(project.summary.path), "已打开项目文件夹。");

  const runSync = async () => {
    if (!project || running) return;
    setFeedback(""); setRunning(true); setSyncMessage("正在启动每日同步…");
    try {
      const run = await api.jobs.run({ projectPath: project.summary.path, job: "daily" });
      setRunId(run.runId);
    } catch (cause) {
      setRunning(false); setSyncMessage("");
      setFeedback(apiErrorMessage(cause, "每日同步启动失败。"));
    }
  };

  if (projectQuery.isLoading) return <div className="si-page-loading" role="status">正在加载项目信息…</div>;
  if (projectQuery.isError || !project) return <ApiErrorNotice page label="项目概览加载失败。" error={projectQuery.error} onRetry={() => void projectQuery.refetch()} />;

  const summary = project.summary;
  return <div className="si-page si-overview-page">
    <ProjectHeader project={summary} activeTab="overview" hasTabPanel status={<Chip tone={summary.sync.state === "ok" ? "ok" : summary.sync.state === "failed" ? "danger" : "warn"}>{syncLabel(summary)}</Chip>} actions={
      <>
        <Button icon={<FolderOpen size={15} />} onClick={() => void openProjectFolder()}>打开项目文件夹</Button>
        <Button variant="primary" icon={<RefreshCw size={15} />} disabled={running} onClick={() => void runSync()}>{running ? "同步中…" : "立即同步"}</Button>
      </>
    } />
    <ProjectTabPanel projectId={summary.id} tab="overview">

    {overviewQuery.isLoading ? <div className="si-page-loading" role="status">正在加载项目概览…</div> : overviewQuery.isError || !overview ? <ApiErrorNotice label="概览数据加载失败。" error={overviewQuery.error} onRetry={() => void overviewQuery.refetch()} /> : <>
    <section className="si-overview-kpis" aria-label="项目指标">
      {overview.kpis.map((metric) => <KpiCard key={metric.key} metric={metric} />)}
    </section>

    <div className="si-overview-grid">
      <div className="si-overview-main-column">
        <section className="si-overview-attention si-panel">
          <div className="si-panel-heading"><h2>需要关注</h2><span>来自今日同步与数据检查</span></div>
          {overview.attention.length ? <ul>
            {overview.attention.map((item, index) => <li key={item.text + index}>
              <Chip tone={severityTone(item.severity)}>{severityLabel(item.severity)}</Chip>
              <span className="si-overview-attention-text">{item.text}</span>
              <a href={item.link} onClick={(event) => { event.preventDefault(); navigate(item.link); }}>{item.link_label}<ExternalLink size={12} aria-hidden="true" /></a>
            </li>)}
          </ul> : <div className="si-empty-state"><Check size={16} />当前没有需要处理的事项。</div>}
        </section>

        <section className="si-overview-readme si-panel">
          <div className="si-panel-heading"><h2>README · 项目概况</h2><a href={"#/p/" + id + "/readme"} onClick={(event) => { event.preventDefault(); navigate("/p/" + id + "/readme"); }}>编辑 README</a></div>
          <p>{overview.readme.overview}</p>
          <div className="si-overview-focus"><span>当前重点</span><p>{overview.readme.focus}</p></div>
        </section>
      </div>

      <aside className="si-overview-side-column">
        <section className="si-overview-actions si-panel">
          <h2>快捷操作</h2>
          <Button icon={<Clipboard size={15} />} onClick={() => void copyInstruction()}>复制 agent 接入指令</Button>
          {overview.agent_instruction && <p className="si-overview-instruction">{overview.agent_instruction}</p>}
          <Button icon={<FileCheck2 size={15} />} onClick={() => void validateFiles()}>校验本地数据文件</Button>
          <Button icon={<FileText size={15} />} onClick={() => void openReadme()}>打开 README</Button>
          <Button icon={<FolderOpen size={15} />} onClick={() => void openProjectFolder()}>打开项目文件夹</Button>
          {(feedback || syncMessage) && <p className="si-overview-feedback" role="status">{syncMessage || feedback}</p>}
        </section>
        <section className="si-overview-changelog si-panel">
          <h2>变更记录</h2>
          {overview.changelog.length ? <ul>{overview.changelog.map((entry, index) => <li key={entry.date + entry.text + index}><time dateTime={entry.date}>{entry.date.slice(5)}</time><span>{entry.text}</span></li>)}</ul> : <div className="si-empty-state"><AlertTriangle size={15} />暂无变更记录。</div>}
        </section>
      </aside>
    </div>
    </>}
    </ProjectTabPanel>
  </div>;
}
import "./overview/page.css";
