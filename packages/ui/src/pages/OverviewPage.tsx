import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, Clipboard, ExternalLink, FileCheck2, FileText, FolderOpen, RefreshCw } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import type { AttentionItem, Kpi, OverviewData, SeoIssue } from "@siteindex/shared";
import { api, apiErrorMessage } from "../api";
import { invalidateProjectSummary, projectQueryKeys } from "../project-queries";
import { ApiErrorNotice, Button, Chip, KpiCard, Notice, PageFrame, ProjectHeader, ProjectTabPanel, useToast } from "../components";
import { OverviewSummary, attentionDestination, labelAttentionText } from "./overview/summary";
import { issueLabels } from "./seo/labels";
import { hasFeedlessProductCollection } from "./project-settings-config/product-source";
function severityTone(severity: AttentionItem["severity"]): "danger" | "warn" | "neutral" {
  return severity === "high" ? "danger" : severity === "mid" ? "warn" : "neutral";
}

function severityLabel(severity: AttentionItem["severity"]): string {
  return severity === "high" ? "高" : severity === "mid" ? "中" : "低";
}

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
  const listPageRows = api.seo.listPageRows;
  const seoCardsQuery = useQuery({ queryKey: ["seo", "pageRows", id, "overview-cards"],
    queryFn: () => listPageRows!(id, { page: 1, pageSize: 1, filters: {} }), enabled: Boolean(listPageRows) });
  const contentCardsQuery = useQuery({ queryKey: ["content", "summary", id], queryFn: () => api.content.summary(id) });
  const edmCardsQuery = useQuery({ queryKey: ["edm", "images", id, "overview-missing"],
    queryFn: () => api.edm.listImages(id, { page: 1, pageSize: 1, filters: { view: "none" } }) });
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
        queryClient.invalidateQueries({ queryKey: ["seo", "pageRows", id] }),
        queryClient.invalidateQueries({ queryKey: ["content", "summary", id] }),
        queryClient.invalidateQueries({ queryKey: ["edm", "images", id] }),
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
  const attention = feedlessCollectionConfigured
    ? overview?.attention.filter((item) => item.text.toLowerCase() !== "尚未填写 gmc feed")
    : overview?.attention;
  const canIgnoreAttention = typeof api.seo.setRuleIgnored === "function";
  const seoSummary = seoCardsQuery.data?.summary;
  const contentKpis = contentCardsQuery.data?.kpis ?? [];
  const blogMetric = (key: string, label: string): Kpi | null => {
    const value = contentKpis.find((item) => item.key === key)?.value;
    return value !== undefined && /^\d+$/.test(value)
      ? { key, label, value, link: `/p/${encodeURIComponent(id)}/content?issue=${key}` } : null;
  };
  const cards: Kpi[] = [
    ...(seoSummary ? [
      { key: "seo-new", label: "本次新增问题页", value: String(seoSummary.new_pages), link: `/p/${encodeURIComponent(id)}/seo?summary=new` },
      { key: "seo-unindexed", label: "未收录页面", value: String(seoSummary.unindexed_pages), link: `/p/${encodeURIComponent(id)}/seo?summary=unindexed` },
    ] : []),
    blogMetric("no_schema", "博客缺少 Schema"),
    blogMetric("no_links", "博客无站内链接"),
    ...(edmCardsQuery.data ? [{ key: "edm-missing", label: "EDM 缺图 SKU", value: String(edmCardsQuery.data.total), link: `/p/${encodeURIComponent(id)}/edm?view=none` }] : []),
  ].filter((item): item is Kpi => item !== null);
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
    {overviewQuery.isLoading ? <div className="si-page-loading" role="status">正在加载项目概览…</div> : overviewQuery.isError || !overview ? <ApiErrorNotice label="概览数据加载失败。" error={overviewQuery.error} onRetry={() => void overviewQuery.refetch()} /> : <>
    {(seoCardsQuery.isError || contentCardsQuery.isError || edmCardsQuery.isError || !listPageRows) && <div className="si-overview-metric-errors">
      {!listPageRows && <Notice tone="warn">当前版本暂不支持 SEO 页面指标。</Notice>}
      {seoCardsQuery.isError && <ApiErrorNotice label="SEO 页面指标加载失败。" error={seoCardsQuery.error} onRetry={() => void seoCardsQuery.refetch()} />}
      {contentCardsQuery.isError && <ApiErrorNotice label="博客指标加载失败。" error={contentCardsQuery.error} onRetry={() => void contentCardsQuery.refetch()} />}
      {edmCardsQuery.isError && <ApiErrorNotice label="EDM 缺图指标加载失败。" error={edmCardsQuery.error} onRetry={() => void edmCardsQuery.refetch()} />}
    </div>}
    {cards.length > 0 && <section className="si-overview-kpis" aria-label="项目指标">
      {cards.map((metric) => <KpiCard key={metric.key} metric={metric} />)}
    </section>}

    <section className="si-overview-attention si-panel">
      <div className="si-panel-heading"><h2>需要关注</h2><span>来自今日同步与数据检查</span></div>
      {attention?.length ? <ul>
        {attention.map((item, index) => {
          const rule = attentionSeoRule(item.link, item.text);
          return <li key={item.text + index}>
            <Chip tone={severityTone(item.severity)}>{severityLabel(item.severity)}</Chip>
            <span className="si-overview-attention-text">{labelAttentionText(item.text)}</span>
            <div className="si-overview-attention-actions">
              <a href={attentionDestination(item.link, id)} onClick={(event) => { event.preventDefault(); navigate(attentionDestination(item.link, id)); }}>{item.link_label}<ExternalLink size={12} aria-hidden="true" /></a>
              {canIgnoreAttention && rule && <Button size="small" onClick={() => void ignoreAttentionRule(rule)}>忽略</Button>}
            </div>
          </li>;
        })}
      </ul> : <div className="si-empty-state"><Check size={16} />当前没有需要处理的事项。</div>}
    </section>

    <section className="si-overview-readme si-panel">
      <div className="si-panel-heading"><h2>README · 项目概况</h2><a href={"#/p/" + id + "/readme"} onClick={(event) => { event.preventDefault(); navigate("/p/" + id + "/readme"); }}>编辑 README</a></div>
      {overview.readme.overview.trim() ? <OverviewSummary markdown={overview.readme.overview} /> : <div className="si-empty-state si-overview-readme-empty">暂无 README 项目概况。</div>}
      {overview.readme.focus.trim() && <div className="si-overview-focus"><span>当前重点</span><p>{overview.readme.focus}</p></div>}
      {overview.agent_instruction && <details className="si-overview-instruction"><summary>Agent 接入指令</summary><pre>{overview.agent_instruction}</pre></details>}
    </section>

    <section className="si-overview-changelog si-panel">
      <h2>变更记录</h2>
      {overview.changelog.length ? <ul>{overview.changelog.map((entry, index) => <li key={entry.date + entry.text + index}><time dateTime={entry.date}>{entry.date.slice(5)}</time><span>{entry.text}</span></li>)}</ul> : <div className="si-empty-state"><AlertTriangle size={15} />暂无变更记录。</div>}
    </section>
    </>}
    </div>
    </ProjectTabPanel>
    </div>
  </PageFrame>;
}
import "./overview/page.css";
