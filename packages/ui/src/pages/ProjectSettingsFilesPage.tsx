import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { FileCheck, FileKind, FileStatus, ListQuery, RepairAction, ValidationReport } from "@siteindex/shared";
import type { ColumnDef } from "@tanstack/react-table";
import { api, apiErrorMessage } from "../api";
import { Button, Chip, ConfirmDialog, DataTable, DetailPanel, Tabs } from "../components";
import "./project-settings-files/page.css";

const projectTabs = [
  { value: "overview", label: "概览" }, { value: "inventory", label: "库存" }, { value: "products", label: "产品" },
  { value: "seo", label: "SEO" }, { value: "content", label: "内容" }, { value: "edm", label: "EDM" },
  { value: "design", label: "设计" }, { value: "readme", label: "README" }, { value: "runs", label: "运行" }, { value: "settings", label: "设置" },
] as const;
const settingsTabs = [
  { value: "config", label: "配置" }, { value: "categories", label: "分类" }, { value: "files", label: "本地文件" },
] as const;
const tabHref = (id: string, value: string) => value === "settings" ? `/p/${id}/settings/config` : `/p/${id}${value === "overview" ? "" : "/" + value}`;
const kindLabels: Record<FileKind, string> = { config: "配置", doc: "说明", sync: "自动", ledger: "台账", view: "视图" };
const statusLabels: Record<FileStatus, string> = { ok: "正常", error: "错误", missing: "缺失", conflict_copy: "冲突副本" };
const statusTones: Record<FileStatus, "ok" | "danger" | "warn" | "info"> = { ok: "ok", error: "danger", missing: "warn", conflict_copy: "warn" };
const actionLabels: Record<string, string> = { autofix: "自动修复", restore_archive: "从归档恢复", delete_copy: "删除副本" };

type FileTableRow = { rowType: "group"; rowId: string; label: string } | { rowType: "file"; rowId: string; file: FileCheck };

function SettingsNav({ id }: { id: string }) {
  return <nav className="si-files-subtabs" aria-label="设置分区">{settingsTabs.map((tab) => <Link key={tab.value} to={`/p/${id}/settings/${tab.value}`} className={tab.value === "files" ? "active" : ""} aria-current={tab.value === "files" ? "page" : undefined}>{tab.label}</Link>)}</nav>;
}

function summarize(files: FileCheck[]): ValidationReport["summary"] {
  return { total: files.length, ok: files.filter((file) => file.status === "ok").length, error: files.filter((file) => file.status === "error").length, missing: files.filter((file) => file.status === "missing").length, conflict_copy: files.filter((file) => file.status === "conflict_copy").length };
}

function groupFor(file: FileCheck): string {
  if (file.path === "README.md" || file.path.startsWith("_agent/") || file.path === "index/site.json") return "配置与说明";
  if (file.path.startsWith("index/catalog/")) return "商品目录";
  if (file.path.startsWith("index/inventory/")) return "库存";
  if (file.path.startsWith("index/seo/")) return "SEO";
  if (file.path.startsWith("index/content/")) return "内容";
  if (file.path.startsWith("index/views/")) return "页面视图";
  if (file.path.startsWith("index/design/")) return "设计规范";
  if (file.path.startsWith("index/edm/")) return "EDM";
  return "归档与其他";
}

function makeTableRows(files: FileCheck[]): FileTableRow[] {
  const groups = new Map<string, FileCheck[]>();
  files.forEach((file) => groups.set(groupFor(file), [...(groups.get(groupFor(file)) ?? []), file]));
  return [...groups].flatMap(([label, rows]) => [
    { rowType: "group" as const, rowId: "group:" + label, label },
    ...rows.map((file) => ({ rowType: "file" as const, rowId: "file:" + file.path, file })),
  ]);
}

function formatSize(size?: number | null): string {
  if (size == null) return "—";
  if (size < 1024) return `${size} B`;
  return `${(size / 1024).toFixed(1)} KB`;
}

function formatModified(value?: string | null): string {
  if (!value) return "—";
  const [date = "", time = ""] = value.split("T");
  return date.length >= 10 ? `${date.slice(5)} ${time.slice(0, 5)}` : "—";
}

function formatCheckedAt(value: string, trigger: ValidationReport["trigger"]): string {
  const today = new Date().toISOString().slice(0, 10);
  const day = value.slice(0, 10) === today ? "今天" : value.slice(5, 10);
  const time = value.split("T")[1]?.slice(0, 5) ?? "—";
  const source = trigger === "schedule" ? "定时任务" : trigger === "after_sync" ? "同步后" : trigger === "cli" ? "CLI" : "手动";
  return `${day} ${time}（${source}）`;
}

function repairLabel(action: RepairAction): string {
  if (action.startsWith("regenerate:")) return "重新生成";
  return actionLabels[action] ?? "修复";
}

export function ProjectSettingsFilesPage() {
  const { id = "kingsyard" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const projectQuery = useQuery({ queryKey: ["projects", id], queryFn: () => api.projects.get(id) });
  const reportQuery = useQuery({ queryKey: ["files", id], queryFn: () => api.files.lastReport(id) });
  const [tableQuery, setTableQuery] = useState<ListQuery>({ page: 1, pageSize: 20 });
  const [selected, setSelected] = useState<FileCheck | null>(null);
  const [pendingRepair, setPendingRepair] = useState<FileCheck | null>(null);
  const [checkingPath, setCheckingPath] = useState<string | null>(null);
  const [validatingAll, setValidatingAll] = useState(false);
  const [repairingPath, setRepairingPath] = useState<string | null>(null);
  const [feedback, setFeedback] = useState("");
  const report = reportQuery.data;
  const files = report?.files ?? [];
  const rows = useMemo(() => makeTableRows(files), [files]);

  const showFeedback = (message: string) => {
    setFeedback(message);
    window.setTimeout(() => setFeedback(""), 2800);
  };

  const saveReport = (next: ValidationReport, path?: string) => {
    if (!path) { queryClient.setQueryData(["files", id], next); return; }
    queryClient.setQueryData<ValidationReport | null>(["files", id], (current) => {
      if (!current) return next;
      const byPath = new Map(current.files.map((file) => [file.path, file]));
      next.files.forEach((file) => byPath.set(file.path, file));
      const merged = [...byPath.values()];
      return { ...current, checked_at: next.checked_at, trigger: next.trigger, files: merged, summary: summarize(merged) };
    });
  };

  const validateAll = async () => {
    if (validatingAll) return;
    setValidatingAll(true);
    try {
      saveReport(await api.files.validate(id));
      showFeedback("全部文件校验完成");
    } catch (error) {
      showFeedback("校验失败：" + (apiErrorMessage(error, "请稍后重试")));
    } finally { setValidatingAll(false); }
  };

  const validateFile = async (file: FileCheck) => {
    setCheckingPath(file.path);
    try {
      const result = await api.files.validate(id, file.path);
      saveReport(result, file.path);
      showFeedback(`已校验「${file.path}」`);
    } catch (error) {
      showFeedback("校验失败：" + (apiErrorMessage(error, "请稍后重试")));
    } finally { setCheckingPath(null); }
  };

  const repairFile = async (file: FileCheck) => {
    const action = file.repair;
    if (!action) return;
    if (action === "delete_copy") { setPendingRepair(file); return; }
    await runRepair(file, action);
  };

  const runRepair = async (file: FileCheck, action: RepairAction) => {
    setRepairingPath(file.path);
    try {
      const repaired = await api.files.repair(id, file.path, action);
      if (selected?.path === file.path) setSelected(action === "delete_copy" ? null : repaired);
      queryClient.setQueryData<ValidationReport | null>(["files", id], (current) => {
        if (!current) return null;
        const nextFiles = action === "delete_copy" ? current.files.filter((item) => item.path !== file.path) : current.files.map((item) => item.path === file.path ? repaired : item);
        return { ...current, checked_at: new Date().toISOString(), trigger: "manual", files: nextFiles, summary: summarize(nextFiles) };
      });
      setPendingRepair(null);
      showFeedback(action === "delete_copy" ? `已将「${file.path}」移入回收站` : `已完成「${file.path}」${repairLabel(action)}`);
    } catch (error) {
      showFeedback("修复失败：" + (apiErrorMessage(error, "请稍后重试")));
    } finally { setRepairingPath(null); }
  };

  const openProjectFolder = async () => {
    try { await api.shell.openPath(projectQuery.data?.summary.path ?? ""); showFeedback("已打开项目文件夹"); }
    catch (error) { showFeedback("打开失败：" + (apiErrorMessage(error, "请稍后重试"))); }
  };

  const columns: ColumnDef<FileTableRow, unknown>[] = [
    { id: "file", header: "文件", size: 300, cell: ({ row }) => row.original.rowType === "group" ? <strong className="si-files-group-label">{row.original.label}</strong> : <code className="si-files-path" title={row.original.file.path}>{row.original.file.path}</code> },
    { id: "kind", header: "类型", size: 78, cell: ({ row }) => row.original.rowType === "group" ? null : <Chip tone={row.original.file.kind === "sync" || row.original.file.kind === "view" ? "ok" : "neutral"}>{kindLabels[row.original.file.kind]}</Chip> },
    { id: "records", header: "记录", size: 82, cell: ({ row }) => row.original.rowType === "group" ? null : <span className="si-files-number">{row.original.file.records == null ? "—" : `${row.original.file.records.toLocaleString("zh-CN")}${row.original.file.kind === "doc" ? "" : " 行"}`}</span> },
    { id: "size", header: "大小", size: 80, cell: ({ row }) => row.original.rowType === "group" ? null : <span className="si-files-number">{formatSize(row.original.file.size)}</span> },
    { id: "modified", header: "最近修改", size: 120, cell: ({ row }) => row.original.rowType === "group" ? null : <code className="si-files-date">{formatModified(row.original.file.modified_at)}</code> },
    { id: "status", header: "状态", size: 250, cell: ({ row }) => row.original.rowType === "group" ? null : <div className="si-files-status"><Chip tone={statusTones[row.original.file.status]}>{statusLabels[row.original.file.status]}</Chip>{row.original.file.message && <span>{row.original.file.message}</span>}</div> },
    { id: "actions", header: "操作", size: 170, cell: ({ row }) => {
      if (row.original.rowType === "group") return null;
      const file = row.original.file;
      return <div className="si-files-actions"><Button size="small" disabled={validatingAll || checkingPath === file.path || repairingPath === file.path} onClick={() => void validateFile(file)}>{checkingPath === file.path ? "校验中…" : "校验"}</Button>{file.status !== "ok" && file.repair && <Button size="small" variant={file.repair === "delete_copy" ? "danger" : "quiet"} disabled={validatingAll || checkingPath === file.path || repairingPath === file.path} onClick={() => void repairFile(file)}>{repairingPath === file.path ? "处理中…" : repairLabel(file.repair)}</Button>}</div>;
    } },
  ];

  if (projectQuery.isLoading || reportQuery.isLoading) return <div className="si-page-loading" role="status">正在读取本地文件校验报告…</div>;
  if (projectQuery.isError || reportQuery.isError || !projectQuery.data) return <div className="si-page-error" role="alert">本地文件加载失败。<button type="button" onClick={() => { void projectQuery.refetch(); void reportQuery.refetch(); }}>重试</button></div>;
  const project = projectQuery.data.summary;
  const summary = report?.summary ?? { total: 0, ok: 0, error: 0, missing: 0, conflict_copy: 0 };

  return <div className="si-page si-files-page">
    <header className="si-project-page-heading"><div className="si-project-title-line"><h1>{project.name}</h1><code>{project.path}</code></div><div className="si-page-actions"><Button onClick={() => void openProjectFolder()}>打开项目文件夹</Button><Button variant="primary" disabled={validatingAll} onClick={() => void validateAll()}>{validatingAll ? "校验中…" : "一键校验全部"}</Button></div></header>
    <Tabs value="settings" options={projectTabs} ariaLabel="项目页面" onChange={(value) => navigate(tabHref(id, value))} />
    <SettingsNav id={id} />
    {feedback && <p className="si-feedback" role="status">{feedback}</p>}
    <section className="si-files-summary" aria-label="文件校验统计"><div><span>文件</span><strong>{summary.total}</strong></div><div><span>正常</span><strong className="is-ok">{summary.ok}</strong></div><div><span>错误</span><strong className="is-error">{summary.error}</strong></div><div><span>缺失</span><strong className="is-warn">{summary.missing}</strong></div><div><span>冲突副本</span><strong className="is-warn">{summary.conflict_copy}</strong></div><small>{report ? `上次全部校验：${formatCheckedAt(report.checked_at, report.trigger)}` : "尚无校验记录"}</small></section>
    <section className="si-files-table-card"><DataTable<FileTableRow> tableId="settings.files" scopeId={id} rows={rows} total={rows.length} columns={columns} query={tableQuery} onQueryChange={setTableQuery} onRowClick={(row) => { if (row.rowType === "file") setSelected(row.file); }} getRowId={(row) => row.rowId} maxHeight={610} rowHeight={52} showPagination={false} emptyTitle="还没有本地文件记录" emptyDescription="点击「一键校验全部」读取项目中的文件与数据状态。" /></section>
    <p className="si-files-note">“重新生成”会执行对应的数据任务，只重建该文件；台账（agent / 用户写的数据）无法从网站重新生成，可从归档恢复或自动修复（排序、格式）。定时任务会执行同样的全部检查。</p>
    <DetailPanel open={Boolean(selected)} onClose={() => setSelected(null)} title={selected?.path ?? "文件详情"}>{selected && <dl className="si-detail-list"><div><dt>类型</dt><dd>{kindLabels[selected.kind]}</dd></div><div><dt>记录数</dt><dd>{selected.records == null ? "—" : selected.records.toLocaleString("zh-CN")}</dd></div><div><dt>大小</dt><dd>{formatSize(selected.size)}</dd></div><div><dt>最近修改</dt><dd>{formatModified(selected.modified_at)}</dd></div><div><dt>状态</dt><dd><Chip tone={statusTones[selected.status]}>{statusLabels[selected.status]}</Chip></dd></div>{selected.rule && <div><dt>校验规则</dt><dd>{selected.rule}</dd></div>}{selected.message && <div><dt>原因</dt><dd>{selected.message}</dd></div>}{selected.line != null && <div><dt>行号</dt><dd>{selected.line.toLocaleString("zh-CN")}</dd></div>}{selected.repair && <div><dt>可用操作</dt><dd>{repairLabel(selected.repair)}</dd></div>}</dl>}</DetailPanel>
    <ConfirmDialog open={Boolean(pendingRepair)} onOpenChange={(open) => { if (!open) setPendingRepair(null); }} title="删除冲突副本？" description={`「${pendingRepair?.path ?? ""}」将移入系统回收站，可以恢复。`} confirmLabel={repairingPath ? "处理中…" : "移入回收站"} onConfirm={() => pendingRepair?.repair ? runRepair(pendingRepair, pendingRepair.repair) : undefined} />
  </div>;
}
