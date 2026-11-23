import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Clipboard, FileCheck2, FileText, FolderOpen, RefreshCw } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import type { AttentionItem, OverviewData, SeoIssue } from "@siteindex/shared";
import { api, apiErrorMessage } from "../api";
import { invalidateProjectSummary, projectQueryKeys } from "../project-queries";
import { ApiErrorNotice, Button, Notice, PageFrame, ProjectHeader, ProjectTabPanel, useToast } from "../components";
import { ProductModule, SeoModule, TodoModule } from "./overview/core-modules";
import { ContentModule, DesignModule, JobsModule } from "./overview/secondary-modules";
import { OverviewSummary, attentionDestination, labelAttentionText } from "./overview/summary";
import { issueLabels } from "./seo/labels";
import { hasFeedlessProductCollection } from "./project-settings-config/product-source";
function projectPath(path: string, file: string): string {
  return path.replace(/[\\/]+$/, "") + (path.includes("\\") ? "\\" : "/") + file;
}

function attentionSeoRule(link: string, text: string): SeoIssue["rule"] | undefined {
  let routeRule: string | null = null;
  try {
    routeRule = new URL(link, "http://siteindex.local").searchParams.get("rule");
  }
  catch { /* 非标准链接仍可从提醒文案中识别规则。 */ }
  if (routeRule && routeRule in issueLabels) return routeRule as SeoIssue["rule"];
  const matches = Object.entries(issueLabels).filter(([rule, label]) => text.includes(rule) || text.includes(label));
  return matches.length === 1 ? matches[0]?.[0] as SeoIssue["rule"] : undefined;
}

export function OverviewPage() {
  const { id = "demo" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const projectQuery = useQuery({ queryKey: projectQueryKeys.detail(id), queryFn: () => api.projects.get(id) });
  const overviewQuery = useQuery({ queryKey: ["overview", id], queryFn: () => api.overview.get(id) });
  const todosApi = api.todos;
  const hasTodos = typeof todosApi?.list === "function";
  const todosQuery = useQuery({ queryKey: ["project-todos", id], queryFn: () => todosApi!.list(id), enabled: hasTodos, retry: false });
  const productQuery = useQuery({ queryKey: ["inventory-summary", id, 30], queryFn: () => api.inventory.summary(id, 30) });
  const seoSummaryQuery = useQuery({ queryKey: ["seo", "summary", id], queryFn: () => api.seo.summary(id) });
  const listPageRows = api.seo.listPageRows;
  const seoCardsQuery = useQuery({ queryKey: ["seo", "pageRows", id, "overview-cards"],
    queryFn: () => listPageRows!(id, { page: 1, pageSize: 1, filters: {} }), enabled: Boolean(listPageRows) });
  const contentSummaryQuery = useQuery({ queryKey: ["content", "summary", id], queryFn: () => api.content.summary(id) });
  const blogQuery = useQuery({ queryKey: ["content", "blogs", id, "overview"],
    queryFn: () => api.content.listBlog(id, { page: 1, pageSize: 0, filters: {} }) });
  const designQuery = useQuery({ queryKey: ["design", id], queryFn: () => api.design.get(id) });
  const jobsQuery = useQuery({ queryKey: ["job-history", id, "overview"], queryFn: () => api.jobs.history(id, 5) });
  const [running, setRunning] = useState(false);
  const [syncMessage, setSyncMessage] = useState("");
  const [runId, setRunId] = useState<string | null>(null);

  useEffect(() => {
    setSyncMessage(""); setRunId(null); setRunning(false);
  }, [id]);

  useEffect(() => {
    if (!runId) return;
    const unsubscribeProgress = api.jobs.onProgress((progress) => {
      if (progress.runId === runId) setSyncMessage(progress.pct + "% · " + progress.message);
    });
    const unsubscribeFinished = api.jobs.onFinished((result) => {
      if (result.runId !== runId) return;
      setRunId(null); setRunning(false); setSyncMessage("");
      if (result.status === "ok") toast.success("每日同步已完成。");
      else toast.error(result.summary);
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ["overview", id] }),
        queryClient.invalidateQueries({ queryKey: ["project-todos", id] }),
        queryClient.invalidateQueries({ queryKey: ["inventory-summary", id] }),
        queryClient.invalidateQueries({ queryKey: ["seo", "summary", id] }),
        queryClient.invalidateQueries({ queryKey: ["seo", "pageRows", id] }),
        queryClient.invalidateQueries({ queryKey: ["content", "summary", id] }),
        queryClient.invalidateQueries({ queryKey: ["content", "blogs", id] }),
        queryClient.invalidateQueries({ queryKey: ["design", id] }),
        queryClient.invalidateQueries({ queryKey: ["job-history", id] }),
        invalidateProjectSummary(queryClient, id),
      ]);
    });
    return () => { unsubscribeProgress(); unsubscribeFinished(); };
  }, [id, queryClient, runId, toast]);

  const project = projectQuery.data;
  const overview: OverviewData | undefined = overviewQuery.data;

  const withToast = async (action: () => Promise<void>, success: string, failure: string) => {
    try { await action(); toast.success(success); }
    catch (cause) { toast.error(apiErrorMessage(cause, failure)); }
  };
  const ignoreAttentionRule = async (rule: SeoIssue["rule"]) => {
    const setRuleIgnored = api.seo.setRuleIgnored;
    if (!setRuleIgnored) return;
    const label = labelAttentionText(rule);
    if (!window.confirm(`忽略“${label}”规则？\n影响范围：全站同一规则。`)) return;
    try {
      const result = await setRuleIgnored(id, rule, true);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["overview", id] }),
        queryClient.invalidateQueries({ queryKey: ["seo", "summary", id] }),
        queryClient.invalidateQueries({ queryKey: ["seo", "issues", id] }),
      ]);
      toast.success(`已更新 ${result.updated} 条`);
    } catch (cause) { toast.error(apiErrorMessage(cause, "SEO 规则忽略失败。")); }
  };

  const copyInstruction = () => withToast(() => api.shell.copyText(overview?.agent_instruction ?? ""), "已复制 agent 接入指令。", "复制 agent 接入指令失败。");
  const validateFiles = async () => {
    try {
      const report = await api.files.validate(id);
      const { ok, error, missing } = report.summary;
      const message = "校验完成：" + ok + " 个文件通过，" + error + " 个错误，" + missing + " 个缺失。";
      if (error || missing) toast.info(message);
      else toast.success(message);
    } catch (cause) { toast.error(apiErrorMessage(cause, "本地数据校验失败。")); }
  };
  const openReadme = () => project && withToast(() => api.shell.openPath(projectPath(project.summary.path, "README.md")), "已打开 README。", "打开 README 失败。");
  const openProjectFolder = () => project && withToast(() => api.shell.openPath(project.summary.path), "已打开项目文件夹。", "打开项目文件夹失败。");

  const runSync = async () => {
    if (!project || running) return;
    setRunning(true); setSyncMessage("正在启动每日同步…");
    try {
      const run = await api.jobs.run({ projectPath: project.summary.path, job: "daily" });
      setRunId(run.runId);
    } catch (cause) {
      setRunning(false); setSyncMessage("");
      toast.error(apiErrorMessage(cause, "每日同步启动失败。"));
    }
  };

  if (projectQuery.isLoading) return <div className="si-page-loading" role="status">正在加载项目信息…</div>;
  if (projectQuery.isError || !project) return <ApiErrorNotice page label="项目概览加载失败。" error={projectQuery.error} onRetry={() => void projectQuery.refetch()} />;

  const summary = project.summary;
  const feedlessCollectionConfigured = hasFeedlessProductCollection(project.config);
  const attention: AttentionItem[] | undefined = feedlessCollectionConfigured
    ? overview?.attention.filter((item) => item.text.toLowerCase() !== "尚未填写 gmc feed")
    : overview?.attention;
  const canIgnoreAttention = typeof api.seo.setRuleIgnored === "function";
  const seoReminders = attention?.flatMap((item) => {
    const rule = attentionSeoRule(item.link, item.text);
    return rule ? [{ rule, text: labelAttentionText(item.text), to: attentionDestination(item.link, id) }] : [];
  }).filter((item, index, all) => all.findIndex((candidate) => candidate.rule === item.rule) === index) ?? [];
  const copyColor = async (hex: string) => {
    try { await api.shell.copyText(hex); toast.success(`已复制 ${hex}。`); }
    catch (cause) { toast.error(apiErrorMessage(cause, "复制颜色失败。")); }
  };
  return <PageFrame kind="project" header={<ProjectHeader
      project={summary}
      activeTab="overview"
      hasTabPanel
      actions={<>
        <Button icon={<FolderOpen size={15} />} onClick={() => void openProjectFolder()}>打开项目文件夹</Button>
        <Button variant="primary" icon={<RefreshCw size={15} />} disabled={running} onClick={() => void runSync()}>{running ? "同步中…" : "立即同步"}</Button>
      </>}
      overflow={[
        { label: "校验本地数据文件", onSelect: () => void validateFiles(), icon: <FileCheck2 size={14} /> },
        { label: "复制 agent 接入指令", onSelect: () => void copyInstruction(), disabled: !overview?.agent_instruction, icon: <Clipboard size={14} /> },
        { label: "打开 README", onSelect: () => void openReadme(), icon: <FileText size={14} /> },
      ]}
    />}>
    <div className="si-page si-overview-page">
    <ProjectTabPanel projectId={summary.id} tab="overview">
    <div className="si-overview-content">
    {running && <Notice tone="info" title="每日同步进行中">{syncMessage || "正在同步项目数据…"}</Notice>}
    {summary.sync.state === "failed" && !running && <Notice tone="error" title="最近一次同步失败">请查看运行记录中的原因，或重新同步。</Notice>}
    <div className="si-overview-modules" aria-label="项目概览模块">
      <TodoModule id={id} available={hasTodos} query={todosQuery} />
      <ProductModule id={id} query={productQuery} />
      <SeoModule id={id} summaryQuery={seoSummaryQuery} pagesQuery={seoCardsQuery} hasPageRows={Boolean(listPageRows)}
        reminders={seoReminders} onIgnore={canIgnoreAttention ? (rule) => void ignoreAttentionRule(rule) : undefined} />
      <ContentModule id={id} summaryQuery={contentSummaryQuery} blogsQuery={blogQuery} coreKeywords={project.config.seo?.core_keywords} />
      <DesignModule id={id} query={designQuery} onCopy={(hex) => void copyColor(hex)} />
      <JobsModule id={id} query={jobsQuery} />
    </div>
    {overviewQuery.isLoading ? <div className="si-page-loading" role="status">正在加载项目概览…</div> : overviewQuery.isError || !overview ? <ApiErrorNotice label="概览数据加载失败。" error={overviewQuery.error} onRetry={() => void overviewQuery.refetch()} /> : <>
    <details className="si-overview-readme si-panel">
      <summary>README · 项目概况</summary>
      <div className="si-overview-readme-body"><div className="si-panel-heading"><a href={"#/p/" + id + "/readme"} onClick={(event) => { event.preventDefault(); navigate("/p/" + id + "/readme"); }}>编辑 README</a></div>
      {overview.readme.overview.trim() ? <OverviewSummary markdown={overview.readme.overview} /> : <div className="si-empty-state si-overview-readme-empty">暂无 README 项目概况。</div>}
      {overview.readme.focus.trim() && <div className="si-overview-focus"><span>当前重点</span><p>{overview.readme.focus}</p></div>}
      {overview.agent_instruction && <details className="si-overview-instruction"><summary>Agent 接入指令</summary><pre>{overview.agent_instruction}</pre></details>}
      </div>
    </details>
    </>}
    </div>
    </ProjectTabPanel>
    </div>
  </PageFrame>;
}
import "./overview/page.css";
