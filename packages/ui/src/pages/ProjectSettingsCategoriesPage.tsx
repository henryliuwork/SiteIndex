import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import type { CategoryMatchType, CategoriesConfig, CategoryPreview, ListQuery, ManualCategory } from "@siteindex/shared";
import { api, apiErrorMessage } from "../api";
import { ApiErrorNotice, Button, Chip, DataTable, DetailPanel, ProjectHeader } from "../components";
import type { ColumnDef } from "@tanstack/react-table";
import "./project-settings-categories/page.css";

const settingsTabs = [
  { value: "config", label: "配置" }, { value: "categories", label: "分类" }, { value: "files", label: "本地文件" },
] as const;
const matchTypeOptions: { value: CategoryMatchType; label: string }[] = [
  { value: "product_type_contains", label: "product_type 包含" }, { value: "sku_prefix", label: "SKU 前缀" },
  { value: "url_contains", label: "URL 包含" }, { value: "skus", label: "指定 SKU" },
];
const matchingModes = [
  { value: "url_rule", title: "URL 规则", hint: "Shopify · WooCommerce", detail: "分类页有固定路径，例如 Shopify /collections/、WooCommerce /product-category/。" },
  { value: "feed", title: "Feed 分类字段", hint: "依赖 feed 质量", detail: "读取 feed 的 product_type 或 google_product_category 分类层级。" },
  { value: "manual", title: "手动配置", hint: "适合 Magento 等", detail: "逐个填写分类名、分类页 URL 和匹配规则；规则按顺序匹配。" },
] as const;

type CategoryRow = ManualCategory & { rowId: string; skuCount: number };

function cloneConfig(value: CategoriesConfig): CategoriesConfig {
  return { ...value, manual: value.manual?.map((category) => ({ ...category, match: category.match.map((rule) => ({ ...rule })) })) };
}

function SettingsNav({ id }: { id: string }) {
  return <nav className="si-category-subtabs" aria-label="设置分区">{settingsTabs.map((tab) => <Link key={tab.value} to={`/p/${id}/settings/${tab.value}`} className={tab.value === "categories" ? "active" : ""} aria-current={tab.value === "categories" ? "page" : undefined}>{tab.label}</Link>)}</nav>;
}

function modeDescription(mode: CategoriesConfig["mode"]): string {
  return matchingModes.find((item) => item.value === mode)?.title ?? "分类识别";
}

function categorySlug(url: string): string {
  const path = url.split(/[?#]/, 1)[0] ?? url;
  const segment = path.split("/").filter(Boolean).at(-1) ?? "new-category";
  return segment.replace(/\.html?$/i, "").replace(/[^a-z0-9-]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "new-category";
}

export function ProjectSettingsCategoriesPage() {
  const { id = "kingsyard" } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const projectQuery = useQuery({ queryKey: ["projects", id], queryFn: () => api.projects.get(id) });
  const configQuery = useQuery({ queryKey: ["categories", id], queryFn: () => api.categories.get(id) });
  const [draft, setDraft] = useState<CategoriesConfig | null>(null);
  const [preview, setPreview] = useState<CategoryPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ message: string; type: "status" | "error" } | null>(null);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [query, setQuery] = useState<ListQuery>({ page: 1, pageSize: 20 });

  useEffect(() => {
    if (!configQuery.data) return;
    const initial = cloneConfig(configQuery.data);
    setDraft(initial);
    let current = true;
    setPreviewing(true);
    void api.categories.preview(id, initial).then((result) => {
      if (current) setPreview(result);
    }).catch((error: unknown) => {
      if (current) setFeedback({ message: "预览失败：" + (apiErrorMessage(error, "请稍后重试")), type: "error" });
    }).finally(() => {
      if (current) setPreviewing(false);
    });
    return () => { current = false; };
  }, [configQuery.data, id]);

  const updateCategory = useCallback((index: number, patch: Partial<ManualCategory>) => {
    setDraft((current) => current ? {
      ...current,
      manual: (current.manual ?? []).map((category, rowIndex) => rowIndex === index ? { ...category, ...patch } : category),
    } : current);
  }, []);
  const updateMatch = useCallback((index: number, ruleIndex: number, patch: Partial<ManualCategory["match"][number]>) => {
    setDraft((current) => current ? {
      ...current,
      manual: (current.manual ?? []).map((category, rowIndex) => rowIndex === index ? {
        ...category,
        match: category.match.map((rule, itemIndex) => itemIndex === ruleIndex ? { ...rule, ...patch } : rule),
      } : category),
    } : current);
  }, []);

  const rows = useMemo<CategoryRow[]>(() => (draft?.manual ?? []).map((category, index) => ({
    ...category, rowId: "category-" + index, skuCount: preview?.categories.find((item) => item.slug === category.slug)?.sku_count ?? 0,
  })), [draft?.manual, preview]);
  const selected = selectedIndex === null ? null : rows[selectedIndex] ?? null;
  const columns = useMemo<ColumnDef<CategoryRow, unknown>[]>(() => [
    { id: "category", header: "分类", size: 140, cell: ({ row }) => <div className="si-category-name-cell"><strong>{row.original.name || "未命名分类"}</strong><code>{row.original.slug}</code></div> },
    { id: "url", accessorKey: "url", header: "分类页 URL", size: 150, cell: ({ row }) => <code className="si-category-url-cell">{row.original.url || "—"}</code> },
    { id: "match", header: "匹配规则（满足任一条）", size: 285, cell: ({ row }) => <div className="si-category-rule-list">{row.original.match.length ? row.original.match.map((rule, index) => <span className="si-category-rule-chip" key={`${row.original.rowId}-${index}`}>{matchTypeOptions.find((option) => option.value === rule.type)?.label} “{rule.value}”</span>) : <span className="si-muted">未设置</span>}</div> },
    { id: "skuCount", accessorKey: "skuCount", header: "SKU", size: 64, cell: ({ getValue }) => <Chip tone={Number(getValue()) > 0 ? "ok" : "warn"}>{Number(getValue()).toLocaleString("zh-CN")}</Chip> },
    { id: "actions", header: "操作", size: 72, cell: ({ row }) => <Button size="small" variant="quiet" onClick={() => setSelectedIndex(Number(row.original.rowId.slice(9)))}>编辑</Button> },
  ], []);

  const previewConfig = async () => {
    if (!draft || previewing) return;
    setPreviewing(true);
    setFeedback(null);
    try {
      setPreview(await api.categories.preview(id, draft));
      setFeedback({ message: "预览结果已更新", type: "status" });
    } catch (error) {
      setFeedback({ message: "预览失败：" + (apiErrorMessage(error, "请稍后重试")), type: "error" });
    } finally {
      setPreviewing(false);
      window.setTimeout(() => setFeedback(null), 2400);
    }
  };

  const saveConfig = async () => {
    if (!draft || saving) return;
    const categories = draft.manual ?? [];
    if (draft.mode === "manual" && categories.some((category) => !category.name.trim() || !category.slug.trim() || !category.url.trim() || category.match.length === 0 || category.match.some((rule) => !rule.value.trim()))) {
      setFeedback({ message: "请补齐分类名、slug、分类页 URL 和至少一条匹配规则。", type: "error" });
      return;
    }
    setSaving(true);
    setFeedback(null);
    try {
      const result = await api.categories.save(id, draft);
      setPreview(result);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["categories", id] }),
        queryClient.invalidateQueries({ queryKey: ["inventory-summary", id] }),
        queryClient.invalidateQueries({ queryKey: ["products", id] }),
      ]);
      setFeedback({ message: "已保存并重新归类", type: "status" });
    } catch (error) {
      setFeedback({ message: "保存失败：" + (apiErrorMessage(error, "请稍后重试")), type: "error" });
    } finally {
      setSaving(false);
      window.setTimeout(() => setFeedback(null), 2400);
    }
  };

  const addCategory = (url = "") => {
    const slug = categorySlug(url || "new-category");
    const index = draft?.manual?.length ?? 0;
    setDraft((current) => current ? { ...current, mode: "manual", manual: [...(current.manual ?? []), { slug, name: "", url, match: [{ type: "url_contains", value: slug }] }] } : current);
    setSelectedIndex(index);
  };

  const addCandidate = (url: string) => {
    if ((draft?.manual ?? []).some((category) => category.url === url)) return;
    const slug = categorySlug(url);
    const name = slug.split("-").filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
    const index = draft?.manual?.length ?? 0;
    setDraft((current) => current ? { ...current, mode: "manual", manual: [...(current.manual ?? []), { slug, name, url, match: [{ type: "url_contains", value: slug }] }] } : current);
    setSelectedIndex(index);
  };

  const importFeedCategories = () => {
    const available = preview?.categories ?? [];
    if (!available.length) return;
    setDraft((current) => {
      if (!current) return current;
      const existing = new Set((current.manual ?? []).map((category) => category.url));
      const imported = available.filter((category) => !existing.has(category.url)).map((category) => ({
        slug: category.slug, name: category.name, url: category.url,
        match: [{ type: "product_type_contains" as const, value: category.name }],
      }));
      return { ...current, mode: "manual", manual: [...(current.manual ?? []), ...imported] };
    });
  };

  const removeCategory = (index: number) => {
    setDraft((current) => current ? { ...current, manual: (current.manual ?? []).filter((_, itemIndex) => itemIndex !== index) } : current);
    setSelectedIndex(null);
  };

  if (projectQuery.isLoading) return <div className="si-page-loading" role="status">正在加载项目信息…</div>;
  if (projectQuery.isError || !projectQuery.data) return <ApiErrorNotice page label="项目分类设置页面加载失败。" error={projectQuery.error} onRetry={() => void projectQuery.refetch()} />;
  const project = projectQuery.data.summary;
  if (configQuery.isError) return <div className="si-page si-category-page">
    <ProjectHeader project={project} activeTab="settings" />
    <SettingsNav id={id} />
    <ApiErrorNotice label="分类配置加载失败。" error={configQuery.error} onRetry={() => void configQuery.refetch()} />
  </div>;
  if (configQuery.isLoading || !draft) return <div className="si-page-loading" role="status">正在加载分类设置…</div>;

  return <div className="si-page si-category-page">
    <ProjectHeader project={project} activeTab="settings" subtitle={`${project.domain} · ${modeDescription(draft.mode)}`} actions={<><Button disabled={previewing} onClick={() => void previewConfig()}>{previewing ? "预览中…" : "预览匹配结果"}</Button><Button variant="primary" disabled={saving} onClick={() => void saveConfig()}>{saving ? "保存中…" : "保存并重新归类"}</Button></>} />
    <SettingsNav id={id} />
    {feedback && <p className={feedback.type === "error" ? "si-form-error" : "si-feedback"} role={feedback.type === "error" ? "alert" : "status"}>{feedback.message}</p>}
    <section className="si-category-mode-section"><h2>分类识别方式</h2><div className="si-category-mode-grid">{matchingModes.map((mode) => <button type="button" key={mode.value} className={`si-category-mode-card${draft.mode === mode.value ? " active" : ""}`} aria-pressed={draft.mode === mode.value} onClick={() => setDraft((current) => current ? { ...current, mode: mode.value } : current)}><span className="si-category-mode-title"><strong>{mode.title}</strong><Chip tone={draft.mode === mode.value ? "ok" : "neutral"}>{draft.mode === mode.value ? "当前" : mode.hint}</Chip></span><span>{mode.detail}</span></button>)}</div></section>
    {draft.mode === "url_rule" && <section className="si-category-url-rule"><label htmlFor="si-category-url-pattern">分类 URL 规则</label><input id="si-category-url-pattern" className="si-text-field si-category-mono" value={draft.url_pattern ?? "/collections/{slug} , /product-category/{slug}/"} onChange={(event) => setDraft((current) => current ? { ...current, url_pattern: event.target.value } : current)} /><p>用 <code>{"{slug}"}</code> 表示分类 slug；支持多个 URL 模式。</p></section>}
    {draft.mode === "feed" && <section className="si-category-feed-note"><strong>使用 Feed 分类字段</strong><span>分类层级读取当前项目配置中的主分类层级；可在「配置 → 数据源」中调整。</span></section>}
    {draft.mode === "manual" && <div className="si-category-layout">
      <section className="si-category-table-card"><div className="si-category-card-heading"><div><h2>手动分类 · {rows.length}</h2><p>规则按顺序匹配，第一个命中的作为主分类。</p></div><Button size="small" onClick={() => addCategory()}>+ 新增分类</Button></div>
        <DataTable<CategoryRow> tableId="categories.manual" scopeId={id} rows={rows} total={rows.length} columns={columns} query={query} onQueryChange={setQuery} onRowClick={(row) => setSelectedIndex(Number(row.rowId.slice(9)))} getRowId={(row) => row.rowId} maxHeight={238} rowHeight={50} showPagination={false} emptyTitle="还没有手动分类" emptyDescription="新增分类并添加匹配规则，预览后保存。" />
        <div className="si-category-table-summary">未归类 SKU <strong>{preview?.uncategorized ?? "—"}</strong><span>属于多个分类 <strong>{preview?.multi_matched ?? "—"}</strong></span><span>规则按顺序匹配</span></div>
      </section>
      <aside className="si-category-candidates"><div className="si-category-card-heading"><div><h2>从 sitemap 发现的候选分类页</h2><p>非产品、非博客页面上列出多个产品的 URL</p></div></div>{(preview?.candidates ?? []).map((candidate) => <div className="si-category-candidate" key={candidate.url}><div><code>{candidate.url}</code><span>{candidate.configured ? "已配置" : `页面列出 ${candidate.product_links} 个产品`}</span></div>{candidate.configured || (draft.manual ?? []).some((category) => category.url === candidate.url) ? <Chip tone="ok">已加入</Chip> : <Button size="small" onClick={() => addCandidate(candidate.url)}>加入</Button>}</div>)}{!preview?.candidates.length && <p className="si-category-empty">暂无候选分类页。预览匹配结果以刷新列表。</p>}<Button size="small" onClick={importFeedCategories}>从 feed 导入分类</Button></aside>
    </div>}
    <DetailPanel open={Boolean(selected)} onClose={() => setSelectedIndex(null)} title={selected?.name || "编辑分类"}>{selected && selectedIndex !== null && <div className="si-category-editor">
      <label>分类名称<input className="si-text-field" value={selected.name} onChange={(event) => updateCategory(selectedIndex, { name: event.target.value })} placeholder="例如 Bird Feeders" /></label>
      <label>Slug<input className="si-text-field si-category-mono" value={selected.slug} onChange={(event) => updateCategory(selectedIndex, { slug: event.target.value })} placeholder="bird-feeders" /></label>
      <label>分类页 URL<input className="si-text-field si-category-mono" value={selected.url} onChange={(event) => updateCategory(selectedIndex, { url: event.target.value })} placeholder="/bird-feeders.html" /></label>
      <fieldset><legend>匹配规则（按顺序）</legend>{selected.match.map((rule, ruleIndex) => <div className="si-category-editor-rule" key={`${selected.rowId}-${ruleIndex}`}>
        <select className="si-text-field" aria-label={`匹配规则类型 ${ruleIndex + 1}`} value={rule.type} onChange={(event) => updateMatch(selectedIndex, ruleIndex, { type: event.target.value as CategoryMatchType })}>{matchTypeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
        <input className="si-text-field" aria-label={`匹配规则值 ${ruleIndex + 1}`} value={rule.value} onChange={(event) => updateMatch(selectedIndex, ruleIndex, { value: event.target.value })} placeholder="输入匹配值" />
        <Button size="small" aria-label={`删除匹配规则 ${ruleIndex + 1}`} onClick={() => setDraft((current) => current ? { ...current, manual: (current.manual ?? []).map((category, index) => index === selectedIndex ? { ...category, match: category.match.filter((_, itemIndex) => itemIndex !== ruleIndex) } : category) } : current)} disabled={selected.match.length <= 1}>删除</Button>
      </div>)}<Button size="small" onClick={() => setDraft((current) => current ? { ...current, manual: (current.manual ?? []).map((category, index) => index === selectedIndex ? { ...category, match: [...category.match, { type: "product_type_contains", value: "" }] } : category) } : current)}>+ 添加匹配规则</Button></fieldset>
      <p className="si-category-editor-count">当前预览命中 {selected.skuCount.toLocaleString("zh-CN")} 个 SKU。编辑后请重新预览匹配结果。</p>
      <div className="si-category-editor-actions"><Button variant="danger" onClick={() => removeCategory(selectedIndex)}>删除分类</Button><Button variant="primary" onClick={() => setSelectedIndex(null)}>完成编辑</Button></div>
    </div>}</DetailPanel>
  </div>;
}
