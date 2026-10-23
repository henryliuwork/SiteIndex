import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { FolderRow, ListQuery } from "@siteindex/shared";
import type { ColumnDef } from "@tanstack/react-table";
import { api } from "../api";
import { Button, Chip, ConfirmDialog, DataTable, DetailPanel, Tabs } from "../components";
import "./project-settings-folders/page.css";

const projectTabs = [
  { value: "overview", label: "概览" }, { value: "inventory", label: "库存" }, { value: "products", label: "产品" },
  { value: "seo", label: "SEO" }, { value: "content", label: "内容" }, { value: "edm", label: "EDM" },
  { value: "design", label: "设计" }, { value: "readme", label: "README" }, { value: "runs", label: "运行" }, { value: "settings", label: "设置" },
] as const;
const settingsTabs = [
  { value: "config", label: "配置" }, { value: "categories", label: "分类" }, { value: "folders", label: "文件夹" }, { value: "files", label: "本地文件" },
] as const;
const tabHref = (id: string, value: string) => value === "settings" ? `/p/${id}/settings/config` : `/p/${id}${value === "overview" ? "" : "/" + value}`;

function SettingsNav({ id }: { id: string }) {
  return <nav className="si-folders-subtabs" aria-label="设置分区">{settingsTabs.map((tab) => <Link key={tab.value} to={`/p/${id}/settings/${tab.value}`} className={tab.value === "folders" ? "active" : ""} aria-current={tab.value === "folders" ? "page" : undefined}>{tab.label}</Link>)}</nav>;
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = value.slice(0, 10);
  return date.length === 10 ? date.slice(5) : "—";
}

export function ProjectSettingsFoldersPage() {
  const { id = "kingsyard" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const projectQuery = useQuery({ queryKey: ["projects", id], queryFn: () => api.projects.get(id) });
  const foldersQuery = useQuery({ queryKey: ["folders", id], queryFn: () => api.folders.list(id) });
  const [query, setQuery] = useState<ListQuery>({ page: 1, pageSize: 20 });
  const [descriptions, setDescriptions] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<FolderRow | null>(null);
  const [pendingDelete, setPendingDelete] = useState<FolderRow | null>(null);
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [savingFolder, setSavingFolder] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const rows = foldersQuery.data ?? [];

  useEffect(() => {
    setDescriptions(Object.fromEntries(rows.map((row) => [row.name, row.description])));
  }, [foldersQuery.data]);

  const updateRows = (nextRows: FolderRow[]) => queryClient.setQueryData(["folders", id], nextRows);
  const report = (message: string) => {
    setFeedback(message);
    window.setTimeout(() => setFeedback(""), 2600);
  };

  const saveDescription = async (row: FolderRow) => {
    const description = descriptions[row.name] ?? row.description;
    if (description === row.description) { report("说明没有变化"); return; }
    setSavingFolder(row.name);
    try {
      updateRows(await api.folders.describe(id, row.name, description));
      report(`已保存「${row.name}」说明`);
    } catch (error) {
      report("保存失败：" + (error instanceof Error ? error.message : "请稍后重试"));
    } finally { setSavingFolder(null); }
  };

  const openFolder = async (name?: string) => {
    setBusy(true);
    try {
      await api.folders.open(id, name);
      report(name ? `已打开「${name}」文件夹` : "已打开项目文件夹");
    } catch (error) {
      report("打开失败：" + (error instanceof Error ? error.message : "请稍后重试"));
    } finally { setBusy(false); }
  };

  const createFolder = async () => {
    const name = newName.trim();
    if (!name) { report("请输入新文件夹名称"); return; }
    if (/[\\/:*?"<>|]/.test(name)) { report("文件夹名称不能包含 \\/:*?\"<>| 等字符"); return; }
    if (rows.some((row) => row.name.toLocaleLowerCase() === name.toLocaleLowerCase())) { report("该文件夹名称已存在"); return; }
    setBusy(true);
    try {
      updateRows(await api.folders.create(id, name, newDescription.trim()));
      setNewName(""); setNewDescription("");
      report(`已创建「${name}」文件夹`);
    } catch (error) {
      report("创建失败：" + (error instanceof Error ? error.message : "请稍后重试"));
    } finally { setBusy(false); }
  };

  const removeFolder = async () => {
    if (!pendingDelete) return;
    const name = pendingDelete.name;
    setBusy(true);
    try {
      updateRows(await api.folders.remove(id, name));
      if (selected?.name === name) setSelected(null);
      report(`已将「${name}」移入回收站`);
    } catch (error) {
      report("删除失败：" + (error instanceof Error ? error.message : "请稍后重试"));
    } finally { setBusy(false); setPendingDelete(null); }
  };

  const columns: ColumnDef<FolderRow, unknown>[] = [
    { id: "folder", header: "文件夹", size: 150, cell: ({ row }) => <div className="si-folder-name"><strong>{row.original.name}</strong><span>/</span></div> },
    { id: "description", header: "说明", size: 450, cell: ({ row }) => <div className="si-folder-description"><input aria-label={`${row.original.name} 文件夹说明`} value={descriptions[row.original.name] ?? row.original.description} placeholder="一句话说明用途" onChange={(event) => setDescriptions((current) => ({ ...current, [row.original.name]: event.target.value }))} /><Button size="small" disabled={savingFolder === row.original.name || busy} onClick={() => void saveDescription(row.original)}>{savingFolder === row.original.name ? "保存中…" : "保存"}</Button></div> },
    { id: "type", header: "类型", size: 80, cell: ({ row }) => <Chip tone={row.original.default ? "neutral" : "info"}>{row.original.default ? "默认" : "自定义"}</Chip> },
    { id: "files", header: "文件", size: 65, cell: ({ row }) => <span className="si-folder-count">{row.original.files.toLocaleString("zh-CN")}</span> },
    { id: "modified", header: "最近修改", size: 92, cell: ({ row }) => <code className="si-folder-date">{formatDate(row.original.modified_at)}</code> },
    { id: "actions", header: "操作", size: 150, cell: ({ row }) => <div className="si-folder-actions"><Button size="small" onClick={() => void openFolder(row.original.name)}>打开</Button><Button size="small" variant="danger" disabled={row.original.default || busy} onClick={() => setPendingDelete(row.original)}>删除</Button></div> },
  ];

  if (projectQuery.isLoading || foldersQuery.isLoading) return <div className="si-page-loading" role="status">正在加载项目文件夹…</div>;
  if (projectQuery.isError || foldersQuery.isError || !projectQuery.data) return <div className="si-page-error" role="alert">项目文件夹加载失败。<button type="button" onClick={() => { void projectQuery.refetch(); void foldersQuery.refetch(); }}>重试</button></div>;
  const project = projectQuery.data.summary;

  return <div className="si-page si-folders-page">
    <header className="si-project-page-heading"><div className="si-project-title-line"><h1>{project.name}</h1><code>{project.path}</code></div><div className="si-page-actions"><Button disabled={busy} onClick={() => void openFolder()}>打开项目文件夹</Button></div></header>
    <Tabs value="settings" options={projectTabs} ariaLabel="项目页面" onChange={(value) => navigate(tabHref(id, value))} />
    <SettingsNav id={id} />
    {feedback && <p className="si-feedback" role="status">{feedback}</p>}
    <section className="si-folders-card">
      <div className="si-folders-heading"><div><h2>工作区文件夹 · {rows.length}</h2><p>说明保存到各文件夹的 _about.md 第一段，并显示在 README 的目录地图中</p></div><Chip tone="ok">所有操作直接作用于本地文件夹</Chip></div>
      <DataTable<FolderRow> tableId="settings.folders" scopeId={id} rows={rows} total={rows.length} columns={columns} query={query} onQueryChange={setQuery} onRowClick={setSelected} getRowId={(row) => row.name} maxHeight={472} rowHeight={58} showPagination={false} emptyTitle="还没有工作区文件夹" emptyDescription="用下方表单新建一个自定义文件夹。" />
      <form className="si-folder-create" onSubmit={(event) => { event.preventDefault(); void createFolder(); }}>
        <label><span>新文件夹名</span><input value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="如 广告" aria-label="新文件夹名" /></label>
        <label className="si-folder-create-description"><span>说明</span><input value={newDescription} onChange={(event) => setNewDescription(event.target.value)} placeholder="一句话说明用途" aria-label="新文件夹说明" /></label>
        <Button variant="primary" disabled={busy}>新建文件夹</Button>
      </form>
    </section>
    <section className="si-folder-system-note"><h2>系统文件夹（由 SiteIndex 维护，不在此编辑）</h2><p><code>index/</code> 网站数据，见「本地文件」　 <code>_agent/</code> agent skills，见 Skill 中心</p></section>
    <p className="si-folder-warning">删除自定义文件夹时，文件夹及其中文件会移到系统回收站，可以恢复；默认文件夹不能删除，但可以修改说明。</p>
    <DetailPanel open={Boolean(selected)} onClose={() => setSelected(null)} title={selected?.name ? `${selected.name}/` : "文件夹详情"}>{selected && <dl className="si-detail-list"><div><dt>类型</dt><dd>{selected.default ? "默认文件夹" : "自定义文件夹"}</dd></div><div><dt>说明</dt><dd>{selected.description || "待补充说明"}</dd></div><div><dt>文件数</dt><dd>{selected.files.toLocaleString("zh-CN")}</dd></div><div><dt>最近修改</dt><dd>{formatDate(selected.modified_at)}</dd></div><div><dt>本地路径</dt><dd className="si-folder-detail-path">{project.path}/{selected.name}</dd></div></dl>}</DetailPanel>
    <ConfirmDialog open={Boolean(pendingDelete)} onOpenChange={(open) => { if (!open) setPendingDelete(null); }} title={`删除「${pendingDelete?.name ?? ""}」文件夹？`} description="文件夹及其中的文件会移到系统回收站，可以恢复。默认文件夹不允许删除。" confirmLabel={busy ? "处理中…" : "移入回收站"} onConfirm={removeFolder} />
  </div>;
}
