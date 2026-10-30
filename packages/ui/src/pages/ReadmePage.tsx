import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import type { ReadmeData } from "@siteindex/shared";
import { PATHS } from "@siteindex/shared";
import { api, apiErrorMessage } from "../api";
import { projectQueryKeys } from "../project-queries";
import { ApiErrorNotice, Button, Chip, ProjectHeader, ProjectTabPanel } from "../components";
const autoDescriptions: Record<string, string> = {
  "task-routing": "7 个任务 → _agent/skills/",
  "data-guide": "index/ 各表说明与写入规则",
  "design-summary": "",
  changelog: "最近 10 条",
};
const blockTitles: Record<string, string> = {
  "index-summary": "网站数据速览",
  "task-routing": "任务路由",
  "data-guide": "数据指南",
  "design-summary": "设计规范速览",
  changelog: "变更记录",
};

function latestUpdate(data: ReadmeData | undefined): string {
  const value = data?.auto_blocks.find((block) => block.id === "index-summary")?.updated_at;
  if (!value) return "暂无自动区块更新时间";
  const date = value.slice(5, 10);
  const time = value.match(/[T ](\d{2}:\d{2})/)?.[1];
  return `自动区块更新于 ${date}${time ? " " + time : ""}`;
}

function UserBlocksCard({ blocks, savedBlocks, onChange, onReset, onSave, saving, editingRules, onEditRules, onCancelRules }: {
  blocks: ReadmeData["user_blocks"];
  savedBlocks: ReadmeData["user_blocks"];
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
  return <section className="si-readme-card si-readme-user-card">
    <div className="si-readme-card-heading"><h2>用户区块</h2><Chip tone="info">你和 agent 编辑</Chip></div>
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
  </section>;
}

function AutoBlocksCard({ data }: { data: ReadmeData }) {
  return <section className="si-readme-card si-readme-auto-card">
    <div className="si-readme-card-heading"><h2>自动区块</h2><Chip tone="ok">SiteIndex 生成 · 只读</Chip></div>
    {data.auto_blocks.map((block) => <div className="si-readme-auto-row" key={block.id}>
        <div className="si-readme-auto-label"><strong>{block.title || blockTitles[block.id] || block.id}</strong><code>{block.id}</code>{autoDescriptions[block.id] && <span>· {autoDescriptions[block.id]}</span>}</div>
        <span>{block.schedule}</span>
      </div>)}
    <p className="si-readme-auto-note">删除某个自动区块的标记后，SiteIndex 不会再把它加回来。</p>
  </section>;
}

export function ReadmePage() {
  const { id = "kingsyard" } = useParams();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<ReadmeData["user_blocks"]>({ overview: "", focus: "", rules: "" });
  const [feedback, setFeedback] = useState("");
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
      setFeedback(result.status === "ok" ? "README 自动区块已刷新。" : result.summary);
      void queryClient.invalidateQueries({ queryKey: ["readme", id] });
    });
    return () => { unsubscribeProgress(); unsubscribeFinished(); };
  }, [activeRunId, id, queryClient]);

  const onOpen = async () => {
    if (!project) return;
    try { await api.shell.openPath(project.path.replace(/[\\/]+$/, "") + "/" + PATHS.readme); setFeedback("已在编辑器中打开 README.md。"); }
    catch (cause) { setFeedback(apiErrorMessage(cause, "打开 README.md 失败。")); }
  };
  const onCopy = async () => {
    try {
      const { body } = await api.skills.get("project-readme");
      await api.shell.copyText(body);
      setFeedback("project-readme 指令已复制。");
    } catch (cause) { setFeedback(apiErrorMessage(cause, "复制 project-readme 指令失败。")); }
  };
  const onRefresh = async () => {
    try {
      setFeedback(""); setRunMessage("正在启动 README 刷新…");
      const run = await api.readme.refresh(id);
      setActiveRunId(run.runId);
    } catch (cause) { setRunMessage(""); setFeedback(apiErrorMessage(cause, "启动 README 刷新失败。")); }
  };
  const onSave = async () => {
    setSaving(true); setFeedback("");
    try {
      await api.readme.saveUserBlocks(id, draft);
      await queryClient.invalidateQueries({ queryKey: ["readme", id] });
      setEditingRules(false);
      setFeedback("README 用户区块已保存。");
    } catch (cause) { setFeedback(apiErrorMessage(cause, "保存用户区块失败。")); }
    finally { setSaving(false); }
  };

  if (projectQuery.isLoading) return <div className="si-page-loading" role="status">正在加载项目信息…</div>;
  if (projectQuery.isError || !project) return <ApiErrorNotice page label="项目 README 页面加载失败。" error={projectQuery.error} onRetry={() => void projectQuery.refetch()} />;

  return <div className="si-page si-readme-page">
    <ProjectHeader project={project} activeTab="readme" hasTabPanel subtitle={`README.md · ${data ? latestUpdate(data) : "—"}`} actions={<><Button onClick={() => void onOpen()}>在编辑器中打开</Button><Button onClick={() => void onCopy()}>复制 project-readme 指令</Button><Button variant="primary" disabled={Boolean(activeRunId)} onClick={() => void onRefresh()}>{activeRunId ? "刷新中…" : "刷新自动区块"}</Button></>} />
    <ProjectTabPanel projectId={project.id} tab="readme">
    {feedback && <p className="si-feedback" role="status">{feedback}</p>}
    {runMessage && <div className="si-sync-progress" role="status">{runMessage}</div>}
    {readmeQuery.isLoading ? <div className="si-page-loading" role="status">正在加载 README…</div> : readmeQuery.isError || !data ? <ApiErrorNotice label="README 内容加载失败。" error={readmeQuery.error} onRetry={() => void readmeQuery.refetch()} /> : <div className="si-readme-layout">
      <UserBlocksCard blocks={draft} savedBlocks={data.user_blocks} onChange={(key, value) => setDraft((current) => ({ ...current, [key]: value }))} onReset={() => { setDraft(data.user_blocks); setEditingRules(false); }} onSave={() => void onSave()} saving={saving} editingRules={editingRules} onEditRules={() => setEditingRules(true)} onCancelRules={() => { setDraft((current) => ({ ...current, rules: data.user_blocks.rules })); setEditingRules(false); }} />
      <AutoBlocksCard data={data} />
    </div>}
    </ProjectTabPanel>
  </div>;
}
import "./readme/page.css";
