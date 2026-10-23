import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { CategoryMatchType, CategoriesConfig, CategoryPreview, ListQuery, ManualCategory } from "@siteindex/shared";
import { api } from "../api";
import { Button, Chip, DataTable, DetailPanel, Tabs } from "../components";
import type { ColumnDef } from "@tanstack/react-table";
import "./project-settings-categories/page.css";

const projectTabs = [
  { value: "overview", label: "概览" }, { value: "inventory", label: "库存" }, { value: "products", label: "产品" },
  { value: "seo", label: "SEO" }, { value: "content", label: "内容" }, { value: "edm", label: "EDM" },
  { value: "design", label: "设计" }, { value: "readme", label: "README" }, { value: "runs", label: "运行" }, { value: "settings", label: "设置" },
] as const;
const settingsTabs = [
  { value: "config", label: "配置" }, { value: "categories", label: "分类" }, { value: "folders", label: "文件夹" }, { value: "files", label: "本地文件" },
] as const;
const tabHref = (id: string, value: string) => value === "settings" ? `/p/${id}/settings/config` : `/p/${id}${value === "overview" ? "" : "/" + value}`;
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
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const projectQuery = useQuery({ queryKey: ["projects", id], queryFn: () => api.projects.get(id) });
  const configQuery = useQuery({ queryKey: ["categories", id], queryFn: () => api.categories.get(id) });
  const [draft, setDraft] = useState<CategoriesConfig | null>(null);
  const [preview, setPreview] = useState<CategoryPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [selected, setSelected] = useState<CategoryRow | null>(null);
  const [query, setQuery] = useState<ListQuery>({ page: 1, pageSize: 20 });

  useEffect(() => {
    if (!configQuery.data) return;
    const initial = cloneConfig(configQuery.data);
    setDraft(initial);
    void api.categories.preview(id, initial).then(setPreview).catch(() => setPreview(null));
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
  const columns = useMemo<ColumnDef<CategoryRow, unknown>[]>(() => [
    { id: "category", header: "分类", size: 175, cell: ({ row }) => <div className="si-category-name-cell"><input aria-label={`${row.original.name || "新分类"} 名称`} value={row.original.name} placeholder="分类名称" onChange={(event) => updateCategory(Number(row.original.rowId.slice(9)), { name: event.target.value })} /><input aria-label={`${row.original.name || "新分类"} slug`} className="si-category-mono" value={row.original.slug} placeholder="slug" onChange={(event) => updateCategory(Number(row.original.rowId.slice(9)), { slug: event.target.value })} /></div> },
    { id: "url", header: "分类页 URL", size: 175, cell: ({ row }) => <input className="si-category-cell-input si-category-mono" aria-label={`${row.original.name || "新分类"} 分类页 URL`} value={row.original.url} placeholder="/collections/category" onChange={(event) => updateCategory(Number(row.original.rowId.slice(9)), { url: event.target.value })} /> },
    { id: "match", header: "匹配规则（按顺序）", size: 310, cell: ({ row }) => {
      const index = Number(row.original.rowId.slice(9));
      return <div className="si-category-rule-list">{row.original.match.map((rule, ruleIndex) => <div className="si-category-rule" key={`${row.original.rowId}-${ruleIndex}`}>
        <select aria-label={`${row.original.name || "新分类"} 匹配规则类型 ${ruleIndex + 1}`} value={rule.type} onChange={(event) => updateMatch(index, ruleIndex, { type: event.target.value as CategoryMatchType })}>{matchTypeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
        <input aria-label={`${row.original.name || "新分类"} 匹配规则值 ${ruleIndex + 1}`} value={rule.value} placeholder="输入匹配值" onChange={(event) => updateMatch(index, ruleIndex, { value: event.target.value })} />
        <button className="si-category-rule-remove" type="button" aria-label="删除匹配规则" onClick={() => setDraft((current) => current ? { ...current, manual: (current.manual ?? []).map((category, rowIndex) => rowIndex === index ? { ...category, match: category.match.filter((_, itemIndex) => itemIndex !== ruleIndex) } : category) } : current)}>×</button>
      </div>)}<button className="si-category-add-rule" type="button" onClick={() => setDraft((current) => current ? { ...current, manual: (current.manual ?? []).map((category, rowIndex) => rowIndex === index ? { ...category, match: [...category.match, { type: "product_type_contains", value: "" }] } : category) } : current)}>+ 添加规则</button></div>;
    } },
    { id: "skuCount", accessorKey: "skuCount", header: "SKU", size: 64, cell: ({ getValue }) => <Chip tone={Number(getValue()) > 0 ? "ok" : "warn"}>{Number(getValue()).toLocaleString("zh-CN")}</Chip> },
    { id: "actions", header: "操作", size: 72, cell: ({ row }) => <Button size="small" variant="quiet" onClick={() => setSelected(row.original)}>编辑</Button> },
  ], [updateCategory, updateMatch]);

  const previewConfig = async () => {
    if (!draft || previewing) return;
    setPreviewing(true);
    setFeedback("");
    try {
      setPreview(await api.categories.preview(id, draft));
      setFeedback("预览结果已更新");
    } catch (error) {
      setFeedback("预览失败：" + (error instanceof Error ? error.message : "请稍后重试"));
    } finally {
      setPreviewing(false);
      window.setTimeout(() => setFeedback(""), 2400);
    }
  };

  const saveConfig = async () => {
    if (!draft || saving) return;
    const categories = draft.manual ?? [];
    if (draft.mode === "manual" && categories.some((category) => !category.name.trim() || !category.slug.trim() || !category.url.trim() || category.match.length === 0 || category.match.some((rule) => !rule.value.trim()))) {
      setFeedback("请补齐分类名、slug、分类页 URL 和至少一条匹配规则。");
      return;
    }
    setSaving(true);
    setFeedback("");
    try {
      const result = await api.categories.save(id, draft);
      setPreview(result);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["categories", id] }),
        queryClient.invalidateQueries({ queryKey: ["inventory-summary", id] }),
        queryClient.invalidateQueries({ queryKey: ["products", id] }),
      ]);
      setFeedback("已保存并重新归类");
    } catch (error) {
      setFeedback("保存失败：" + (error instanceof Error ? error.message : "请稍后重试"));
    } finally {
      setSaving(false);
      window.setTimeout(() => setFeedback(""), 2400);
    }
  };

  const addCategory = (url = "") => {
    const slug = categorySlug(url || "new-category");
    setDraft((current) => current ? { ...current, mode: "manual", manual: [...(current.manual ?? []), { slug, name: "", url, match: [{ type: "url_contains", value: slug }] }] } : current);
  };

  const addCandidate = (url: string) => {
    if ((draft?.manual ?? []).some((category) => category.url === url)) return;
    const slug = categorySlug(url);
    const name = slug.split("-").filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
    setDraft((current) => current ? { ...current, mode: "manual", manual: [...(current.manual ?? []), { slug, name, url, match: [{ type: "url_contains", value: slug }] }] } : current);
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

  const removeCategory = (slug: string) => setDraft((current) => current ? { ...current, manual: (current.manual ?? []).filter((category) => category.slug !== slug) } : current);

  if (projectQuery.isLoading || configQuery.isLoading || !draft) return <div className="si-page-loading" role="status">正在加载分类设置…</div>;
  if (projectQuery.isError || configQuery.isError || !projectQuery.data) return <div className="si-page-error" role="alert">分类设置加载失败。<button type="button" onClick={() => { void projectQuery.refetch(); void configQuery.refetch(); }}>重试</button></div>;
  const project = projectQuery.data.summary;

  return <div className="si-page si-category-page">
    <header className="si-project-page-heading"><div className="si-project-title-line"><h1>{project.name}</h1><code>{project.domain} · {modeDescription(draft.mode)}</code></div><div className="si-page-actions"><Button disabled={previewing} onClick={() => void previewConfig()}>{previewing ? "预览中…" : "预览匹配结果"}</Button><Button variant="primary" disabled={saving} onClick={() => void saveConfig()}>{saving ? "保存中…" : "保存并重新归类"}</Button></div></header>
    <Tabs value="settings" options={projectTabs} ariaLabel="项目页面" onChange={(value) => navigate(tabHref(id, value))} />
    <SettingsNav id={id} />
    {feedback && <p className="si-feedback" role="status">{feedback}</p>}
    <section className="si-category-mode-section"><h2>分类识别方式</h2><div className="si-category-mode-grid">{matchingModes.map((mode) => <button type="button" key={mode.value} className={`si-category-mode-card${draft.mode === mode.value ? " active" : ""}`} aria-pressed={draft.mode === mode.value} onClick={() => setDraft((current) => current ? { ...current, mode: mode.value } : current)}><span className="si-category-mode-title"><strong>{mode.title}</strong><Chip tone={draft.mode === mode.value ? "ok" : "neutral"}>{draft.mode === mode.value ? "当前" : mode.hint}</Chip></span><span>{mode.detail}</span></button>)}</div></section>
    {draft.mode === "url_rule" && <section className="si-category-url-rule"><label htmlFor="si-category-url-pattern">分类 URL 规则</label><input id="si-category-url-pattern" className="si-text-field si-category-mono" value={draft.url_pattern ?? "/collections/{slug} , /product-category/{slug}/"} onChange={(event) => setDraft((current) => current ? { ...current, url_pattern: event.target.value } : current)} /><p>用 <code>{"{slug}"}</code> 表示分类 slug；支持多个 URL 模式。</p></section>}
    {draft.mode === "feed" && <section className="si-category-feed-note"><strong>使用 Feed 分类字段</strong><span>分类层级读取当前项目配置中的主分类层级；可在「配置 → 数据源」中调整。</span></section>}
    {draft.mode === "manual" && <div className="si-category-layout">
      <section className="si-category-table-card"><div className="si-category-card-heading"><div><h2>手动分类 · {rows.length}</h2><p>规则按顺序匹配，第一个命中的作为主分类。</p></div><Button size="small" onClick={() => addCategory()}>+ 新增分类</Button></div>
        <DataTable<CategoryRow> tableId="categories.manual" scopeId={id} rows={rows} total={rows.length} columns={columns} query={query} onQueryChange={setQuery} onRowClick={setSelected} getRowId={(row) => row.rowId} maxHeight={366} rowHeight={70} showPagination={false} emptyTitle="还没有手动分类" emptyDescription="新增分类并添加匹配规则，预览后保存。" />
        <div className="si-category-table-summary">未归类 SKU <strong>{preview?.uncategorized ?? "—"}</strong><span>属于多个分类 <strong>{preview?.multi_matched ?? "—"}</strong></span><span>匹配规则自上而下检查</span></div>
      </section>
      <aside className="si-category-candidates"><div className="si-category-card-heading"><div><h2>从 sitemap 发现的候选分类页</h2><p>非产品、非博客页面上列出多个产品的 URL</p></div></div>{(preview?.candidates ?? []).map((candidate) => <div className="si-category-candidate" key={candidate.url}><div><code>{candidate.url}</code><span>{candidate.configured ? "已配置" : `页面列出 ${candidate.product_links} 个产品`}</span></div>{candidate.configured || (draft.manual ?? []).some((category) => category.url === candidate.url) ? <Chip tone="ok">已加入</Chip> : <Button size="small" onClick={() => addCandidate(candidate.url)}>加入</Button>}</div>)}{!preview?.candidates.length && <p className="si-category-empty">暂无候选分类页。预览匹配结果以刷新列表。</p>}<Button size="small" onClick={importFeedCategories}>从 feed 导入分类</Button></aside>
    </div>}
    {preview && <section className="si-category-preview" aria-live="polite"><div><span>预览分类</span><strong>{preview.categories.length}</strong></div><div><span>未归类 SKU</span><strong>{preview.uncategorized.toLocaleString("zh-CN")}</strong></div><div><span>命中多个分类</span><strong>{preview.multi_matched.toLocaleString("zh-CN")}</strong></div></section>}
    <DetailPanel open={Boolean(selected)} onClose={() => setSelected(null)} title={selected?.name || "分类详情"}>{selected && <dl className="si-detail-list"><div><dt>Slug</dt><dd className="si-category-mono">{selected.slug}</dd></div><div><dt>分类页 URL</dt><dd className="si-category-mono">{selected.url}</dd></div><div><dt>匹配规则</dt><dd>{selected.match.map((rule, index) => <span key={index}>{matchTypeOptions.find((item) => item.value === rule.type)?.label}：{rule.value}{index < selected.match.length - 1 ? "；" : ""}</span>)}</dd></div><div><dt>匹配 SKU</dt><dd>{selected.skuCount.toLocaleString("zh-CN")}</dd></div></dl>}</DetailPanel>
  </div>;
}
