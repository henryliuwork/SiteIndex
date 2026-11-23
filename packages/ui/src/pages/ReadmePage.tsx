import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import type { ReadmeData } from "@siteindex/shared";
import { PATHS } from "@siteindex/shared";
import { api, apiErrorMessage } from "../api";
import { projectQueryKeys } from "../project-queries";
import { ApiErrorNotice, Button, Card, formatDateTime, InfoTooltip, Notice, PageFrame, ProjectHeader, ProjectTabPanel, useToast } from "../components";
const blockTitles: Record<string, string> = {
  "index-summary": "网站数据速览",
  "task-routing": "任务路由",
  "data-guide": "数据指南",
  "design-summary": "设计规范速览",
  changelog: "变更记录",
};
const userBlockTitles: Record<keyof ReadmeData["user_blocks"], string> = {
  overview: "项目概况",
  focus: "当前重点",
  rules: "工作规则与偏好",
};

function latestUpdate(data: ReadmeData | undefined): string {
  const value = data?.auto_blocks.find((block) => block.id === "index-summary")?.updated_at;
  if (!value) return "网站数据速览自动区块：暂无更新时间";
  return `网站数据速览自动区块更新于 ${formatDateTime(value)}`;
}

function UserBlocksCard({ blocks, savedBlocks, missingBlocks, onChange, onReset, onSave, saving, editingRules, onEditRules, onCancelRules }: {
  blocks: ReadmeData["user_blocks"];
  savedBlocks: ReadmeData["user_blocks"];
  missingBlocks?: ReadmeData["missing_user_blocks"];
  onChange: (key: keyof ReadmeData["user_blocks"], value: string) => void;
  onReset: () => void;
  onSave: () => void;
  saving: boolean;
  editingRules: boolean;
  onEditRules: () => void;
  onCancelRules: () => void;
}) {
  const fields: { key: keyof ReadmeData["user_blocks"]; label: string; rows: number }[] = [
    { key: "overview", label: "项目概况", rows: 5 },
    { key: "focus", label: "当前重点", rows: 3 },
    { key: "rules", label: "工作规则与偏好", rows: 4 },
  ];
  return <Card className="si-readme-card si-readme-user-card" label="README 用户区块">
    <div className="si-readme-card-heading"><h2>用户区块</h2><InfoTooltip label="用户区块说明" content="由你和 Agent 编辑，SiteIndex 不会自动覆盖。" /></div>
    {missingBlocks?.length ? <Notice tone="warn" title="README 段落缺失">缺少：{missingBlocks.map((key) => userBlockTitles[key]).join("、")}。保存后会补齐标题并写入内容。</Notice> : null}
    {fields.map(({ key, label, rows }) => key === "rules" ? <div className="si-readme-field" key={key}>
      <span>{label}</span>
      {editingRules ? <>
        <textarea className="si-readme-textarea" rows={rows} value={blocks[key]} onChange={(event) => onChange(key, event.target.value)} aria-label={label} />
        <div className="si-readme-rules-actions"><Button size="small" disabled={saving} onClick={onCancelRules}>取消编辑</Button></div>
      </> : <div className="si-readme-rules-display">
        <p>{savedBlocks.rules || "暂无工作规则与偏好。"}</p>
        <Button size="small" onClick={onEditRules}>编辑</Button>
      </div>}
    </div> : <label className="si-readme-field" key={key}>
      <span>{label}</span>
      <textarea className="si-readme-textarea" rows={rows} value={blocks[key]} onChange={(event) => onChange(key, event.target.value)} aria-label={label} />
    </label>)}
    <div className="si-readme-edit-actions">
      <Button disabled={saving} onClick={onReset}>撤销</Button>
      <Button variant="primary" disabled={saving} onClick={onSave}>{saving ? "保存中…" : "保存"}</Button>
    </div>
  </Card>;
}

function AutoBlocksCard({ data }: { data: ReadmeData }) {
  return <Card className="si-readme-card si-readme-auto-card" label="README 自动区块">
    <div className="si-readme-card-heading"><h2>自动区块</h2><InfoTooltip label="自动区块说明" content={`由 SiteIndex 生成；删除标记后不会自动恢复。${latestUpdate(data)}`} /></div>
    {data.auto_blocks.map((block) => <div className="si-readme-auto-row" key={block.id}>
        <div className="si-readme-auto-label"><strong>{block.title || blockTitles[block.id] || block.id}</strong><code>{block.id}</code></div>
        <span>{block.schedule}</span>
      </div>)}
  </Card>;
}

export function ReadmePage() {
  const { id = "demo" } = useParams();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<ReadmeData["user_blocks"]>({ overview: "", focus: "", rules: "" });
  const [saving, setSaving] = useState(false);
  const [editingRules, setEditingRules] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [runMessage, setRunMessage] = useState("");
  const projectQuery = useQuery({ queryKey: projectQueryKeys.detail(id), queryFn: () => api.projects.get(id) });
  const readmeQuery = useQuery({ queryKey: ["readme", id], queryFn: () => api.readme.get(id) });
  const project = projectQuery.data?.summary;
  const data = readmeQuery.data;

  useEffect(() => {
    if (data) setDraft(data.user_blocks);
  }, [data, id]);
  useEffect(() => {
    if (!activeRunId) return;
    const unsubscribeProgress = api.jobs.onProgress((progress) => {
      if (progress.runId === activeRunId) setRunMessage(progress.message);
    });
    const unsubscribeFinished = api.jobs.onFinished((result) => {
      if (result.runId !== activeRunId) return;
      setActiveRunId(null);
      setRunMessage("");
      result.status === "ok" ? toast.success("README 自动区块已刷新。") : toast.error(result.summary);
      void queryClient.invalidateQueries({ queryKey: ["readme", id] });
    });
    return () => { unsubscribeProgress(); unsubscribeFinished(); };
  }, [activeRunId, id, queryClient, toast]);

  const onOpen = async () => {
    if (!project) return;
    try { await api.shell.openPath(project.path.replace(/[\\/]+$/, "") + "/" + PATHS.readme); toast.success("已在编辑器中打开 README.md。"); }
    catch (cause) { toast.error(apiErrorMessage(cause, "打开 README.md 失败。")); }
  };
  const onCopy = async () => {
    try {
      const { body } = await api.skills.get("project-readme");
      await api.shell.copyText(body);
      toast.success("project-readme 指令已复制。");
    } catch (cause) { toast.error(apiErrorMessage(cause, "复制 project-readme 指令失败。")); }
  };
  const onRefresh = async () => {
    try {
      setRunMessage("正在启动 README 刷新…");
      const run = await api.readme.refresh(id);
      setActiveRunId(run.runId);
      toast.info("README 刷新已启动。");
    } catch (cause) { setRunMessage(""); toast.error(apiErrorMessage(cause, "启动 README 刷新失败。")); }
  };
  const onSave = async () => {
    setSaving(true);
    try {
      await api.readme.saveUserBlocks(id, draft);
      await queryClient.invalidateQueries({ queryKey: ["readme", id] });
      setEditingRules(false);
      toast.success("README 用户区块已保存。");
    } catch (cause) { toast.error(apiErrorMessage(cause, "保存用户区块失败。")); }
    finally { setSaving(false); }
  };

  const stateHeader = <div className="si-project-header si-project-header-single">README</div>;
  if (projectQuery.isLoading) return <PageFrame kind="project" scroll="content" header={stateHeader}><div className="si-page-loading" role="status">正在加载项目信息…</div></PageFrame>;
  if (projectQuery.isError || !project) return <PageFrame kind="project" scroll="content" header={stateHeader}><ApiErrorNotice page label="项目 README 页面加载失败。" error={projectQuery.error} onRetry={() => void projectQuery.refetch()} /></PageFrame>;

  return <PageFrame kind="project" scroll="content" header={<ProjectHeader project={project} activeTab="readme" hasTabPanel actions={<><Button onClick={() => void onOpen()}>在编辑器中打开</Button><Button onClick={() => void onCopy()}>复制 project-readme 指令</Button><Button variant="primary" disabled={Boolean(activeRunId)} onClick={() => void onRefresh()}>{activeRunId ? "刷新中…" : "刷新自动区块"}</Button></>} />}><div className="si-page si-readme-page">
    <ProjectTabPanel projectId={project.id} tab="readme">
    {runMessage && <Notice tone="info">{runMessage}</Notice>}
    {readmeQuery.isLoading ? <div className="si-page-loading" role="status">正在加载 README…</div> : readmeQuery.isError || !data ? <ApiErrorNotice label="README 内容加载失败。" error={readmeQuery.error} onRetry={() => void readmeQuery.refetch()} /> : <div className="si-readme-layout">
      <UserBlocksCard blocks={draft} savedBlocks={data.user_blocks} missingBlocks={data.missing_user_blocks} onChange={(key, value) => setDraft((current) => ({ ...current, [key]: value }))} onReset={() => { setDraft(data.user_blocks); setEditingRules(false); }} onSave={() => void onSave()} saving={saving} editingRules={editingRules} onEditRules={() => setEditingRules(true)} onCancelRules={() => { setDraft((current) => ({ ...current, rules: data.user_blocks.rules })); setEditingRules(false); }} />
      <AutoBlocksCard data={data} />
    </div>}
    </ProjectTabPanel>
  </div></PageFrame>;
}
import "./readme/page.css";
