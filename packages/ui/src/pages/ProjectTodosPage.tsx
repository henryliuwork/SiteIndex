import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import type { ListQuery, PathKey, ProjectTodo, TodoManualHistoryEntry, TodoManualStatus, UpdateTodoManualInput } from "@siteindex/shared";
import { Link, useParams } from "react-router-dom";
import { AlertCircle, CheckCircle2, ClipboardList, Clock3, FileSearch, MinusCircle } from "lucide-react";
import { ApiErrorNotice, Button, Chip, DataTable, Drawer, EmptyState, FilterBar, formatDateTime, Input, Notice, PageHeader, Select, useToast } from "../components";
import { api, apiErrorMessage, isMockApi } from "../api";
import { projectQueryKeys } from "../project-queries";
import "./project-todos/page.css";

type TodoQueryFilters = { status?: TodoManualStatus };
type TodoUpdateSubmission =
  | { dedupe_key: string; field: "status"; input: Extract<UpdateTodoManualInput, { status: TodoManualStatus }> }
  | { dedupe_key: string; field: "note"; input: Extract<UpdateTodoManualInput, { note: string | null }> };
const initialQuery: ListQuery<TodoQueryFilters> = { page: 1, pageSize: 50, filters: {} };

const statusLabels: Record<TodoManualStatus, string> = {
  open: "待处理",
  in_progress: "进行中",
  pending_review: "待复核",
  done: "已完成",
  ignored: "已忽略",
};

const statusTones: Record<TodoManualStatus, "neutral" | "info" | "warn" | "ok"> = {
  open: "warn",
  in_progress: "info",
  pending_review: "warn",
  done: "ok",
  ignored: "neutral",
};

const severityLabels = { high: "高", mid: "中", low: "低" } as const;
const severityTones = { high: "danger", mid: "warn", low: "neutral" } as const;
const pathLabels: Partial<Record<PathKey, string>> = {
  site: "项目配置",
  skus: "商品 Feed",
  inventoryLatest: "库存记录",
  seoPages: "SEO 页面",
  seoIssues: "SEO 问题",
  blogIndex: "博客索引",
  categories: "分类数据",
  productsView: "产品视图",
  skuStockView: "库存视图",
  todos: "规则待办",
  todoStates: "待办状态",
  todoHistory: "待办操作记录",
};

function StatusChip({ status }: { status: TodoManualStatus }) {
  return <Chip tone={statusTones[status]}>{statusLabels[status]}</Chip>;
}

function scanSummary(status: "not_run" | "complete" | "partial" | "failed", evaluatedAt: string | null) {
  const evaluated = evaluatedAt ? `最近检查于 ${formatDateTime(evaluatedAt)}` : "尚无检查时间记录";
  if (status === "complete") return { tone: null, title: "", message: evaluated } as const;
  if (status === "partial") return { tone: "warn" as const, title: "检查结果不完整", message: `${evaluated}。尚未读取或信任全部规则来源；当前列表不能证明未出现的待办已经解决。` };
  if (status === "failed") return { tone: "error" as const, title: "规则检查失败", message: `${evaluated}。已保留可用的待办记录；缺失项不能视为已完成。` };
  return { tone: "info" as const, title: "规则检查尚未运行", message: "当前没有可信的规则检查结果，不能据此判断项目没有待办。" };
}

function historyLabel(entry: TodoManualHistoryEntry): string {
  if (entry.action === "status_changed") {
    return `状态：${entry.from_status ? statusLabels[entry.from_status] : "首次记录"} → ${statusLabels[entry.to_status]}`;
  }
  if (entry.action === "note_changed") return entry.note === null ? "清除了备注" : `更新备注：${entry.note}`;
  return `规则再次匹配：${statusLabels[entry.from_status]} → ${statusLabels[entry.to_status]}`;
}

function historyIcon(entry: TodoManualHistoryEntry) {
  if (entry.action === "status_changed") return <CheckCircle2 size={16} aria-hidden="true" />;
  if (entry.action === "note_changed") return <ClipboardList size={16} aria-hidden="true" />;
  return <AlertCircle size={16} aria-hidden="true" />;
}

function filterFinding(item: ProjectTodo, search: string, status: string): boolean {
  if (status && item.state.status !== status) return false;
  if (!search) return true;
  const value = [
    item.finding.title,
    item.finding.detail,
    item.finding.rule_id,
    item.finding.subject.kind,
    item.finding.subject.key,
    item.finding.subject.label,
    item.state.note,
    ...item.finding.sources.flatMap((source) => [source.path, source.record_key]),
  ].filter(Boolean).join(" ").toLocaleLowerCase("zh-CN");
  return value.includes(search);
}

export function ProjectTodosPage() {
  const { id = "demo" } = useParams<{ id: string }>();
  const [query, setQuery] = useState(initialQuery);
  const [selectedTodo, setSelectedTodo] = useState<ProjectTodo | null>(null);
  const [draftStatus, setDraftStatus] = useState<TodoManualStatus>("open");
  const [draftNote, setDraftNote] = useState("");
  const todosApi = api.todos;
  const hasListApi = typeof todosApi?.list === "function";
  const hasUpdateApi = typeof todosApi?.update === "function";
  const hasHistoryApi = typeof todosApi?.history === "function";
  const queryClient = useQueryClient();
  const toast = useToast();
  const projectQuery = useQuery({ queryKey: projectQueryKeys.detail(id), queryFn: () => api.projects.get(id) });
  const todosQuery = useQuery({
    queryKey: ["project-todos", id],
    queryFn: () => todosApi!.list(id),
    enabled: hasListApi,
    retry: false,
  });
  const selectedDedupeKey = selectedTodo?.finding.dedupe_key ?? null;
  const historyQuery = useQuery({
    queryKey: ["project-todo-history", id, selectedDedupeKey],
    queryFn: () => todosApi!.history(id, selectedDedupeKey!),
    enabled: Boolean(selectedDedupeKey && hasHistoryApi),
    retry: false,
  });
  const updateMutation = useMutation({
    mutationFn: ({ input }: TodoUpdateSubmission) => todosApi!.update(id, input),
    onSuccess: async (state, submission) => {
      setSelectedTodo((current) => current?.finding.dedupe_key === submission.dedupe_key ? { ...current, state } : current);
      if (submission.field === "status") setDraftStatus(state.status);
      else setDraftNote(state.note ?? "");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["project-todos", id], exact: true }),
        queryClient.invalidateQueries({ queryKey: ["project-todo-history", id, submission.dedupe_key], exact: true }),
      ]);
      toast.success(submission.field === "status" ? "待办状态已保存。" : "待办备注已保存。");
    },
    onError: (error, submission) => {
      toast.error(apiErrorMessage(error, submission.field === "status" ? "待办状态保存失败，请重试。" : "待办备注保存失败，请重试。"));
    },
  });

  const allItems = todosQuery.data?.items ?? [];
  const search = (query.search ?? "").trim().toLocaleLowerCase("zh-CN");
  const statusFilter = query.filters?.status ?? "";
  const filteredItems = useMemo(
    () => allItems.filter((item) => filterFinding(item, search, statusFilter)),
    [allItems, search, statusFilter],
  );
  const pageSize = query.pageSize > 0 ? query.pageSize : filteredItems.length;
  const pageOffset = Math.max(0, query.page - 1) * pageSize;
  const rows = filteredItems.slice(pageOffset, pageOffset + pageSize);
  const selectTodo = (item: ProjectTodo) => {
    setSelectedTodo(item);
    setDraftStatus(item.state.status);
    setDraftNote(item.state.note ?? "");
  };
  const saveStatus = () => {
    if (!selectedTodo || !hasUpdateApi || selectedTodo.state.status === draftStatus) return;
    updateMutation.mutate({
      dedupe_key: selectedTodo.finding.dedupe_key,
      field: "status",
      input: { dedupe_key: selectedTodo.finding.dedupe_key, status: draftStatus },
    });
  };
  const saveNote = () => {
    if (!selectedTodo || !hasUpdateApi || selectedTodo.state.note === (draftNote.trim() || null)) return;
    updateMutation.mutate({
      dedupe_key: selectedTodo.finding.dedupe_key,
      field: "note",
      input: { dedupe_key: selectedTodo.finding.dedupe_key, note: draftNote.trim() || null },
    });
  };
  const columns = useMemo<ColumnDef<ProjectTodo, unknown>[]>(() => [
    {
      id: "finding",
      header: "待办事项",
      accessorFn: (item) => item.finding.title,
      cell: ({ row }) => <div className="si-todo-finding-cell">
        <strong>{row.original.finding.title}</strong>
        {row.original.finding.detail && <small>{row.original.finding.detail}</small>}
      </div>,
      meta: { width: 360, grow: 2, minWidth: 260, text: "clamp2" },
    },
    {
      id: "rule",
      header: "规则来源",
      accessorFn: (item) => item.finding.rule_id,
      cell: ({ row }) => <div className="si-todo-rule-cell">
        <code>{row.original.finding.rule_id}</code>
        <small>{row.original.finding.sources.length} 个来源记录</small>
      </div>,
      meta: { width: 230, grow: 1, minWidth: 170, text: "clamp2" },
    },
    {
      id: "status",
      header: "状态",
      accessorFn: (item) => item.state.status,
      cell: ({ row }) => <StatusChip status={row.original.state.status} />,
      meta: { width: 120, grow: 0, minWidth: 110 },
    },
    {
      id: "severity",
      header: "级别",
      accessorFn: (item) => item.finding.severity ?? "",
      cell: ({ row }) => row.original.finding.severity
        ? <Chip tone={severityTones[row.original.finding.severity]}>{severityLabels[row.original.finding.severity]}</Chip>
        : <span className="si-muted">—</span>,
      meta: { width: 90, grow: 0, minWidth: 80 },
    },
    {
      id: "last_seen",
      header: "最近发现",
      accessorFn: (item) => item.finding.last_seen_at,
      cell: ({ row }) => <span>{formatDateTime(row.original.finding.last_seen_at)}</span>,
      meta: { width: 150, grow: 0, minWidth: 140 },
    },
  ], []);

  const project = projectQuery.data?.summary;
  const scan = todosQuery.data?.scan;
  const scanStatus = scan ? scanSummary(scan.status, scan.evaluated_at) : null;
  const pageHeader = <PageHeader
    title="项目待办"
    meta={project
      ? <><span>{project.name} · {project.domain}</span><Link className="si-todo-back-link" to={`/p/${id}`}>返回项目概览</Link></>
      : "规则结果、人工状态和检查记录"}
  />;

  if (projectQuery.isLoading) return <div className="si-page-loading" role="status">正在打开项目待办…</div>;
  if (projectQuery.isError || !project) return <div className="si-page si-project-todos-page">
    {pageHeader}
    <ApiErrorNotice page label="无法读取项目信息" error={projectQuery.error} onRetry={() => void projectQuery.refetch()} />
  </div>;

  if (!hasListApi) return <div className="si-page si-project-todos-page">
    {pageHeader}
    <Notice tone="warn" title="当前运行环境尚未接入项目待办">
      待办页面和规则数据契约已准备好，但当前桌面桥接没有提供读取方法。请升级到包含 Core 与 Desktop 待办接线的版本后重试。
    </Notice>
  </div>;

  if (todosQuery.isPending) return <div className="si-page si-project-todos-page">
    {pageHeader}
    <div className="si-todo-loading" role="status">正在读取项目待办…</div>
  </div>;

  if (todosQuery.isError || !todosQuery.data) return <div className="si-page si-project-todos-page">
    {pageHeader}
    <ApiErrorNotice page label="项目待办读取失败" error={todosQuery.error} detail="未将读取失败解释为“没有待办”。" onRetry={() => void todosQuery.refetch()} />
  </div>;

  const emptyTitle = allItems.length > 0 ? "没有匹配的待办"
    : scan?.status === "complete" ? "当前没有待办"
      : scan?.status === "partial" ? "暂时没有可确认的待办"
        : scan?.status === "failed" ? "检查失败，无法确认待办状态" : "没有可用的检查结果";
  const emptyDescription = allItems.length > 0 ? "清除搜索或调整状态筛选后重试。"
    : scan?.status === "complete" ? "最近一次完整检查没有发现需要展示的项目待办。"
      : scan?.status === "partial" ? "部分来源不可用；请在检查完整后再判断项目是否有待办。"
        : scan?.status === "failed" ? "请稍后重试，或检查失败的来源文件。"
          : "运行一次规则检查后，可信的结果会显示在这里。";

  return <div className="si-page si-project-todos-page">
    {pageHeader}
    {isMockApi && <Notice tone="info" title="虚构演示数据">当前待办与来源记录均为本地合成样例，不对应真实项目检查结果。</Notice>}
    {scanStatus?.tone && <Notice tone={scanStatus.tone} title={scanStatus.title}>{scanStatus.message}</Notice>}

    <DataTable<ProjectTodo, TodoQueryFilters>
      tableId="project.todos"
      scopeId={id}
      rows={rows}
      total={filteredItems.length}
      columns={columns}
      query={query}
      onQueryChange={(next) => setQuery((current) => ({ ...next, search: current.search, filters: current.filters }))}
      onRowClick={selectTodo}
      getRowId={(item) => item.finding.dedupe_key}
      height="fill"
      rowHeight={58}
      emptyTitle={emptyTitle}
      emptyDescription={emptyDescription}
      toolbar={<FilterBar className="si-todo-filter-bar">
        <Input
          aria-label="搜索项目待办"
          className="si-todo-search"
          placeholder="搜索标题、规则、来源或备注"
          value={query.search ?? ""}
          onChange={(event) => setQuery((current) => ({ ...current, page: 1, search: event.target.value || undefined }))}
        />
        <Select
          ariaLabel="待办状态筛选"
          value={query.filters?.status ?? "all"}
          options={[
            { value: "all", label: "全部状态" },
            ...Object.entries(statusLabels).map(([value, label]) => ({ value, label })),
          ]}
          onValueChange={(value) => setQuery((current) => ({
            ...current,
            page: 1,
            filters: { status: value === "all" ? undefined : value as TodoManualStatus },
          }))}
        />
        <span className="si-todo-result-count">{filteredItems.length} 项</span>
      </FilterBar>}
    />

    <Drawer
      open={Boolean(selectedTodo)}
      onOpenChange={(open) => { if (!open) setSelectedTodo(null); }}
      title={selectedTodo?.finding.title ?? "待办详情"}
      description={selectedTodo ? `${selectedTodo.finding.rule_id} · ${selectedTodo.finding.subject.label ?? selectedTodo.finding.subject.key}` : undefined}
      width="wide"
    >
      {selectedTodo && <div className="si-todo-detail">
        <section className="si-todo-detail-summary">
          <h3>状态与备注</h3>
          <dl>
            <div><dt>当前状态</dt><dd><StatusChip status={selectedTodo.state.status} /></dd></div>
            <div><dt>规则编号</dt><dd><code>{selectedTodo.finding.rule_id}</code></dd></div>
            <div><dt>对象</dt><dd>{selectedTodo.finding.subject.label ?? selectedTodo.finding.subject.key} <span className="si-muted">({selectedTodo.finding.subject.kind})</span></dd></div>
            <div><dt>首次发现</dt><dd>{formatDateTime(selectedTodo.finding.first_seen_at)}</dd></div>
            <div><dt>最近发现</dt><dd>{formatDateTime(selectedTodo.finding.last_seen_at)}</dd></div>
            <div><dt>备注</dt><dd>{selectedTodo.state.note?.trim() || <span className="si-muted">尚无备注</span>}</dd></div>
          </dl>
          {selectedTodo.finding.detail && <p>{selectedTodo.finding.detail}</p>}
          {hasUpdateApi ? <div className="si-todo-edit-controls">
            <div className="si-todo-edit-field">
              <span>更新状态</span>
              <div className="si-todo-edit-row">
                <Select
                  ariaLabel="更新待办状态"
                  value={draftStatus}
                  options={Object.entries(statusLabels).map(([value, label]) => ({ value, label }))}
                  onValueChange={(value) => setDraftStatus(value as TodoManualStatus)}
                  disabled={updateMutation.isPending}
                />
                <Button
                  size="small"
                  variant="primary"
                  disabled={updateMutation.isPending || draftStatus === selectedTodo.state.status}
                  onClick={saveStatus}
                >{updateMutation.isPending ? "正在保存…" : "保存状态"}</Button>
              </div>
            </div>
            <div className="si-todo-edit-field">
              <label htmlFor="si-todo-note-edit">备注</label>
              <textarea
                id="si-todo-note-edit"
                aria-label="编辑待办备注"
                className="si-todo-note-input"
                rows={4}
                value={draftNote}
                disabled={updateMutation.isPending}
                onChange={(event) => setDraftNote(event.target.value)}
                placeholder="补充处理说明；留空保存会清除备注"
              />
              <div className="si-todo-edit-actions">
                <Button
                  size="small"
                  variant="primary"
                  disabled={updateMutation.isPending || selectedTodo.state.note === (draftNote.trim() || null)}
                  onClick={saveNote}
                >{updateMutation.isPending ? "正在保存…" : "保存备注"}</Button>
              </div>
            </div>
          </div> : <Notice tone="warn" title="待办编辑接口尚未接入">
            当前运行环境可以读取待办，但还没有提供状态与备注保存方法；编辑内容未启用。
          </Notice>}
        </section>

        <section className="si-todo-detail-sources">
          <h3><FileSearch size={16} aria-hidden="true" />规则依据</h3>
          <ul>
            {selectedTodo.finding.sources.map((source, index) => <li key={`${source.path}-${source.record_key}-${index}`}>
              <strong>{pathLabels[source.path] ?? source.path}</strong>
              <code>{source.path}</code>
              <span>记录：{source.record_key}</span>
              <small>数据采集于 {formatDateTime(source.collected_at)}</small>
            </li>)}
          </ul>
        </section>

        <section className="si-todo-detail-history">
          <h3><Clock3 size={16} aria-hidden="true" />操作记录</h3>
          {!hasHistoryApi
            ? <Notice tone="warn" title="操作记录接口尚未接入">当前运行环境可以显示待办状态，但没有提供历史查询方法。</Notice>
            : historyQuery.isPending
              ? <p className="si-todo-inline-status" role="status">正在读取操作记录…</p>
              : historyQuery.isError
                ? <ApiErrorNotice label="操作记录读取失败" error={historyQuery.error} onRetry={() => void historyQuery.refetch()} />
                : historyQuery.data?.length
                  ? <ol>{historyQuery.data.map((entry) => <li key={entry.event_id}>
                    <span className="si-todo-history-icon">{historyIcon(entry)}</span>
                    <div><strong>{historyLabel(entry)}</strong><small>{formatDateTime(entry.changed_at)}</small></div>
                  </li>)}</ol>
                  : <EmptyState icon={<MinusCircle size={20} />} title="暂无操作记录">状态或备注调整、规则重新命中后会显示在这里。</EmptyState>}
        </section>
      </div>}
    </Drawer>
  </div>;
}
