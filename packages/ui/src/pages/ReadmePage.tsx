import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import type { ReadmeData } from "@siteindex/shared";
import { PATHS } from "@siteindex/shared";
import { api, apiErrorMessage } from "../api";
import { Button, Chip, Tabs } from "../components";

const tabOptions = [
  { value: "overview", label: "概览" }, { value: "inventory", label: "库存" },
  { value: "products", label: "产品" }, { value: "seo", label: "SEO" },
  { value: "content", label: "内容" }, { value: "edm", label: "EDM" },
  { value: "design", label: "设计" }, { value: "readme", label: "README" },
  { value: "runs", label: "运行" }, { value: "settings", label: "设置" },
] as const;
const projectTabsHref = (id: string, value: string): string => value === "settings" ? `/p/${id}/settings/config` : `/p/${id}${value === "overview" ? "" : "/" + value}`;
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

function ProjectHeading({ name, updated, onOpen, onCopy, onRefresh, refreshing, onNavigate }: {
  name: string;
  updated: string;
  onOpen: () => void;
  onCopy: () => void;
  onRefresh: () => void;
  refreshing: boolean;
  onNavigate: (value: string) => void;
}) {
  return <>
    <header className="si-project-page-heading">
      <div className="si-project-title-line si-readme-title-line"><h1>{name}</h1><code>README.md · {updated}</code></div>
      <div className="si-page-actions">
        <Button onClick={onOpen}>在编辑器中打开</Button>
        <Button onClick={onCopy}>复制 project-readme 指令</Button>
        <Button variant="primary" disabled={refreshing} onClick={onRefresh}>{refreshing ? "刷新中…" : "刷新自动区块"}</Button>
      </div>
    </header>
    <Tabs value="readme" options={tabOptions} ariaLabel="项目页面" onChange={onNavigate} />
  </>;
}

function UserBlocksCard({ blocks, onChange, onReset, onSave, saving }: {
  blocks: ReadmeData["user_blocks"];
  onChange: (key: keyof ReadmeData["user_blocks"], value: string) => void;
  onReset: () => void;
  onSave: () => void;
  saving: boolean;
}) {
  const fields: { key: keyof ReadmeData["user_blocks"]; label: string; rows: number }[] = [
    { key: "overview", label: "项目概况", rows: 5 },
    { key: "focus", label: "当前重点", rows: 3 },
    { key: "rules", label: "工作规则与偏好", rows: 4 },
  ];
  return <section className="si-readme-card si-readme-user-card">
    <div className="si-readme-card-heading"><h2>用户区块</h2><Chip tone="info">你和 agent 编辑</Chip></div>
    {fields.map(({ key, label, rows }) => <label className="si-readme-field" key={key}>
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
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<ReadmeData["user_blocks"]>({ overview: "", focus: "", rules: "" });
  const [feedback, setFeedback] = useState("");
  const [saving, setSaving] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [runMessage, setRunMessage] = useState("");
  const projectQuery = useQuery({ queryKey: ["project", id], queryFn: () => api.projects.get(id) });
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
      setFeedback("README 用户区块已保存。");
    } catch (cause) { setFeedback(apiErrorMessage(cause, "保存用户区块失败。")); }
    finally { setSaving(false); }
  };

  if (projectQuery.isLoading || readmeQuery.isLoading) return <div className="si-page-loading" role="status">正在加载 README…</div>;
  if (projectQuery.isError || readmeQuery.isError || !project || !data) return <div className="si-page-error" role="alert">README 页面加载失败。<button type="button" onClick={() => { void projectQuery.refetch(); void readmeQuery.refetch(); }}>重试</button></div>;

  return <div className="si-page si-readme-page">
    <ProjectHeading name={project.name} updated={latestUpdate(data)} onOpen={() => void onOpen()} onCopy={() => void onCopy()} onRefresh={() => void onRefresh()} refreshing={Boolean(activeRunId)} onNavigate={(value) => navigate(projectTabsHref(id, value))} />
    {feedback && <p className="si-feedback" role="status">{feedback}</p>}
    {runMessage && <div className="si-sync-progress" role="status">{runMessage}</div>}
    <div className="si-readme-layout">
      <UserBlocksCard blocks={draft} onChange={(key, value) => setDraft((current) => ({ ...current, [key]: value }))} onReset={() => setDraft(data.user_blocks)} onSave={() => void onSave()} saving={saving} />
      <AutoBlocksCard data={data} />
    </div>
  </div>;
}
import "./readme/page.css";
