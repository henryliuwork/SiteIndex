import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import * as Dialog from "@radix-ui/react-dialog";
import { ExternalLink, Image as ImageIcon, Plus, RefreshCw, Tag, Trash2, X } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import type { ListQuery, ProductFilters, ProductFull, ProductView, ProjectDetail, StockStatus } from "@siteindex/shared";
import { api } from "../api";
import { Button, Chip, ConfirmDialog, DataTable, DetailPanel, FilterPill, Tabs, stockTone } from "../components";

const tabOptions = [
  { value: "overview", label: "概览" }, { value: "inventory", label: "库存" },
  { value: "products", label: "产品" }, { value: "seo", label: "SEO" },
  { value: "content", label: "内容" }, { value: "edm", label: "EDM" },
  { value: "design", label: "设计" }, { value: "readme", label: "README" },
  { value: "runs", label: "运行" }, { value: "settings", label: "设置" },
] as const;
const initialQuery: ListQuery<ProductFilters> = { page: 1, pageSize: 100, filters: {} };
const stockLabels: Record<StockStatus, string> = { in_stock: "有货", out_of_stock: "缺货", preorder: "预售", unknown: "未知" };
const stockOptions = [
  { value: "all", label: "全部" }, { value: "in", label: "有货" },
  { value: "out", label: "缺货" }, { value: "other", label: "预售 / 未知" },
] as const;

const platformNames: Record<ProjectDetail["summary"]["platform"], string> = {
  magento: "Magento", wordpress: "WordPress", woocommerce: "WooCommerce", shopify: "Shopify", other: "其他平台",
};

function priceLabel(product: ProductView): string {
  if (product.price_min === null) return "—";
  if (product.price_max === null || product.price_min === product.price_max) return product.price_min.toFixed(2);
  return product.price_min.toFixed(2) + "–" + product.price_max.toFixed(2);
}

function priceCell(product: ProductView) {
  const current = priceLabel(product);
  return <span className="si-product-price">{product.on_sale && product.compare_at_max !== null && <del>{product.compare_at_max.toFixed(2)}</del>}<strong>{current}</strong></span>;
}

function ProductThumbnail({ src }: { src: string | null }) {
  const [failed, setFailed] = useState(false);
  return src && !failed
    ? <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} />
    : <span className="si-product-thumb-placeholder"><ImageIcon size={16} /></span>;
}

function ProductPreview({ src, alt }: { src: string | null; alt: string }) {
  const [failed, setFailed] = useState(false);
  return <div className="si-product-detail-image">{src && !failed ? <img src={src} alt={alt} onError={() => setFailed(true)} /> : <ImageIcon size={32} aria-label="暂无商品图片" />}</div>;
}

function productColumns(): ColumnDef<ProductView, unknown>[] {
  return [
    { id: "product", accessorKey: "title", header: "产品", cell: ({ row }) => {
      const product = row.original;
      return <span className="si-product-main-cell">
        <ProductThumbnail src={product.image_url} />
        <span className="si-product-main-copy"><strong>{product.title}</strong><span><code>{product.handle}</code>{product.price_dropped_at && <Chip tone="warn">降价</Chip>}{product.restocked_at && <Chip tone="ok">到货</Chip>}{product.is_new && <Chip tone="info">新品</Chip>}</span></span>
      </span>;
    }, enableSorting: true },
    { id: "category", accessorKey: "category", header: "分类", cell: ({ row }) => <code className="si-mono">{row.original.category || "—"}</code>, enableSorting: true },
    { id: "price", accessorKey: "price_min", header: "价格", cell: ({ row }) => priceCell(row.original), enableSorting: true },
    { id: "in_stock_variants", accessorKey: "in_stock_variants", header: "有货变体", cell: ({ row }) => row.original.in_stock_variants + "/" + row.original.variant_count, enableSorting: true },
    { id: "stock_status", accessorKey: "stock_status", header: "库存", cell: ({ row }) => <Chip tone={stockTone[row.original.stock_status]}>{stockLabels[row.original.stock_status]}</Chip>, enableSorting: true },
    { id: "tags", accessorKey: "tags", header: "标签", cell: ({ row }) => <span className="si-product-tags-cell">{row.original.tags.slice(0, 3).map((tag) => <span className="si-product-tag" key={tag}>{tag}</span>)}{row.original.exclude_edm === 1 && <span className="si-product-tag si-product-tag-warn">不进 EDM</span>}</span>, enableSorting: false },
    { id: "rating", accessorKey: "rating", header: "评分", cell: ({ row }) => row.original.rating == null ? "—" : row.original.rating.toFixed(1) + (row.original.review_count ? " (" + row.original.review_count + ")" : ""), enableSorting: true },
    { id: "units_30d", accessorKey: "units_30d", header: "30天销量", cell: () => "—", enableSorting: false, meta: { reserved: true } },
    { id: "revenue_30d", accessorKey: "revenue_30d", header: "30天销售额", cell: () => "—", enableSorting: false, meta: { reserved: true } },
  ];
}

function ProductDetailContent({
  detail, tags, isSaving, feedback, onAddTag, onCreateAndAddTag, onRemoveTag,
}: {
  detail: ProductFull;
  tags: string[];
  isSaving: boolean;
  feedback: string;
  onAddTag: (tag: string) => void;
  onCreateAndAddTag: (tag: string) => void;
  onRemoveTag: (tag: string) => void;
}) {
  const [existingTag, setExistingTag] = useState("");
  const [newTag, setNewTag] = useState("");
  const product = detail.product;
  const image = product.manual_image_url ?? product.feed_image_url ?? product.image_url ?? detail.details?.gallery[0] ?? null;
  const schemas = detail.seo?.schema_types ?? [];
  return <div className="si-product-detail">
    <ProductPreview src={image} alt={product.title} />
    <div className="si-product-detail-title"><span>{product.category || "未分类"}</span><a href={product.url} onClick={(event) => { event.preventDefault(); void api.shell.openExternal(product.url); }}>打开商品页 <ExternalLink size={12} /></a></div>
    <h3>{product.title}</h3>
    <p className="si-product-detail-handle"><code>{product.handle}</code> · {product.variant_count} 个变体</p>
    <div className="si-product-detail-facts">
      <div><span>价格</span><strong>{priceLabel(product)}</strong></div>
      <div><span>库存</span><Chip tone={stockTone[product.stock_status]}>{stockLabels[product.stock_status]}</Chip></div>
      <div><span>评分</span><strong>{product.rating == null ? "—" : product.rating.toFixed(1) + (product.review_count ? " · " + product.review_count + " 条评价" : "")}</strong></div>
    </div>
    {detail.details?.short_description && <section><h4>商品简介</h4><p>{detail.details.short_description}</p></section>}
    <section className="si-product-detail-tag-section">
      <h4>标签</h4>
      <div className="si-product-detail-tags">{product.tags.length ? product.tags.map((tag) => <span className="si-product-tag" key={tag}>{tag}<button type="button" aria-label={"移除标签 " + tag} disabled={isSaving} onClick={() => onRemoveTag(tag)}><X size={12} /></button></span>) : <span className="si-muted">暂无标签</span>}</div>
      <div className="si-product-tag-editor"><select aria-label="从已有标签中添加" value={existingTag} onChange={(event) => setExistingTag(event.target.value)}><option value="">选择已有标签</option>{tags.filter((tag) => !product.tags.includes(tag)).map((tag) => <option value={tag} key={tag}>{tag}</option>)}</select><Button size="small" disabled={!existingTag || isSaving} onClick={() => { onAddTag(existingTag); setExistingTag(""); }}><Plus size={13} />添加</Button></div>
      <div className="si-product-tag-editor"><input aria-label="新建并添加标签" value={newTag} onChange={(event) => setNewTag(event.target.value)} placeholder="新建标签" /><Button size="small" disabled={!newTag.trim() || isSaving} onClick={() => { onCreateAndAddTag(newTag.trim()); setNewTag(""); }}><Plus size={13} />新建并添加</Button></div>
      {feedback && <p className="si-product-feedback" role="status">{feedback}</p>}
    </section>
    <section>
      <h4>SEO</h4>
      {detail.seo ? <div className="si-product-seo-detail">
        <div><span>Title</span><p>{detail.seo.title || "—"}</p></div>
        <div><span>Robots</span><p>{detail.seo.robots_meta || "默认可索引"}</p></div>
        <div><span>Schema</span><div className="si-product-schema-list">{schemas.length ? schemas.map((schema) => <span className="si-product-schema-pill" key={schema}>{schema}</span>) : <span className="si-muted">未检测到 Schema</span>}</div></div>
        <div><span>Google 收录</span><p>{detail.seo.google_indexed === true ? "已收录" : detail.seo.google_indexed === false ? "未收录" : "未检查"}</p></div>
      </div> : <p className="si-muted">暂无 SEO 页面数据。</p>}
    </section>
    {detail.skus.length > 0 && <section><h4>SKU 与变体</h4><ul className="si-product-sku-list">{detail.skus.slice(0, 8).map((sku) => <li key={sku.sku}><code>{sku.sku}</code><span>{sku.variant_title || "默认变体"}</span></li>)}</ul></section>}
  </div>;
}

export function ProductsPage() {
  const { id = "kingsyard" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState<ListQuery<ProductFilters>>(initialQuery);
  const [selectedHandle, setSelectedHandle] = useState<string | null>(null);
  const [tagDialogOpen, setTagDialogOpen] = useState(false);
  const [newTag, setNewTag] = useState("");
  const [deleteTag, setDeleteTag] = useState<string | null>(null);
  const [feedback, setFeedback] = useState("");
  const [detailFeedback, setDetailFeedback] = useState("");
  const [isSavingTags, setIsSavingTags] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [syncMessage, setSyncMessage] = useState("");
  const projectQuery = useQuery({ queryKey: ["project", id], queryFn: () => api.projects.get(id) });
  const listQuery = useQuery({ queryKey: ["products", id, query], queryFn: () => api.products.list(id, query), placeholderData: (previous) => previous });
  const tagsQuery = useQuery({ queryKey: ["product-tags", id], queryFn: () => api.products.listTags(id) });
  const detailQuery = useQuery({ queryKey: ["product", id, selectedHandle], queryFn: () => api.products.get(id, selectedHandle ?? ""), enabled: Boolean(selectedHandle) });
  const columns = useMemo(productColumns, []);
  const stock = query.filters?.stock ?? "all";
  const tag = query.filters?.tag ?? "all";
  const project = projectQuery.data?.summary;
  const detail = detailQuery.data;

  useEffect(() => {
    setQuery(initialQuery); setSelectedHandle(null); setTagDialogOpen(false); setNewTag(""); setDeleteTag(null);
    setFeedback(""); setDetailFeedback("");
  }, [id]);
  useEffect(() => {
    if (!activeRunId) return;
    const unsubscribeProgress = api.jobs.onProgress((event) => { if (event.runId === activeRunId) setSyncMessage(event.message); });
    const unsubscribeFinished = api.jobs.onFinished((result) => {
      if (result.runId !== activeRunId) return;
      setActiveRunId(null); setSyncMessage(""); setFeedback(result.status === "ok" ? "每日同步已完成。" : result.summary);
      void queryClient.invalidateQueries({ queryKey: ["products", id] });
      void queryClient.invalidateQueries({ queryKey: ["project", id] });
    });
    return () => { unsubscribeProgress(); unsubscribeFinished(); };
  }, [activeRunId, id, queryClient]);

  const onTabChange = (tab: typeof tabOptions[number]["value"]) => navigate(tab === "settings" ? "/p/" + id + "/settings/config" : "/p/" + id + (tab === "overview" ? "" : "/" + tab));
  const onStockChange = (value: string | undefined) => setQuery((current) => ({ ...current, page: 1, filters: { ...current.filters, stock: !value || value === "all" ? undefined : value as ProductFilters["stock"] } }));
  const onTagChange = (value: string | undefined) => setQuery((current) => ({ ...current, page: 1, filters: { ...current.filters, tag: !value || value === "all" ? undefined : value } }));

  const exportCsv = async () => {
    setFeedback("");
    try { const path = await api.products.exportCsv(id, query); await api.shell.openPath(path); setFeedback("产品 CSV 已导出。"); }
    catch (cause) { setFeedback(cause instanceof Error ? cause.message : "产品 CSV 导出失败。"); }
  };
  const runSync = async () => {
    if (!project || activeRunId) return;
    setFeedback(""); setSyncMessage("正在启动每日同步…");
    try { const run = await api.jobs.run({ projectPath: project.path, job: "daily" }); setActiveRunId(run.runId); }
    catch (cause) { setSyncMessage(""); setFeedback(cause instanceof Error ? cause.message : "同步任务启动失败。"); }
  };
  const updateTags = async (tags: string[]) => {
    if (!selectedHandle) return;
    setIsSavingTags(true); setDetailFeedback("");
    try {
      const saved = await api.products.setTags(id, selectedHandle, tags);
      queryClient.setQueryData<ProductFull>(["product", id, selectedHandle], (current) => current ? { ...current, product: { ...current.product, tags: saved } } : current);
      await Promise.all([queryClient.invalidateQueries({ queryKey: ["products", id] }), queryClient.invalidateQueries({ queryKey: ["product-tags", id] })]);
      setDetailFeedback("标签已保存。");
    } catch (cause) { setDetailFeedback(cause instanceof Error ? cause.message : "标签保存失败。"); }
    finally { setIsSavingTags(false); }
  };
  const createAndAddTag = async (name: string) => {
    if (!selectedHandle || !name) return;
    setIsSavingTags(true); setDetailFeedback("");
    try {
      await api.products.createTag(id, name);
      const saved = await api.products.setTags(id, selectedHandle, [...(detail?.product.tags ?? []), name]);
      queryClient.setQueryData<ProductFull>(["product", id, selectedHandle], (current) => current ? { ...current, product: { ...current.product, tags: saved } } : current);
      await Promise.all([queryClient.invalidateQueries({ queryKey: ["products", id] }), queryClient.invalidateQueries({ queryKey: ["product-tags", id] })]);
      setDetailFeedback("标签已创建并添加。");
    } catch (cause) { setDetailFeedback(cause instanceof Error ? cause.message : "标签创建失败。"); }
    finally { setIsSavingTags(false); }
  };
  const createManagedTag = async () => {
    const name = newTag.trim();
    if (!name) return;
    setFeedback("");
    try { await api.products.createTag(id, name); await queryClient.invalidateQueries({ queryKey: ["product-tags", id] }); setNewTag(""); setFeedback("标签已创建。"); }
    catch (cause) { setFeedback(cause instanceof Error ? cause.message : "标签创建失败。"); }
  };
  const removeManagedTag = async () => {
    if (!deleteTag) return;
    try { await api.products.deleteTag(id, deleteTag); await Promise.all([queryClient.invalidateQueries({ queryKey: ["product-tags", id] }), queryClient.invalidateQueries({ queryKey: ["products", id] })]); setFeedback("标签已删除。"); }
    catch (cause) { setFeedback(cause instanceof Error ? cause.message : "标签删除失败。"); }
  };

  if (projectQuery.isLoading || listQuery.isLoading) return <div className="si-page-loading" role="status">正在加载产品…</div>;
  if (projectQuery.isError || listQuery.isError || !project || !listQuery.data) return <div className="si-page-error" role="alert">产品页面加载失败。<button type="button" onClick={() => { void projectQuery.refetch(); void listQuery.refetch(); }}>重试</button></div>;

  return <div className="si-page si-products-page">
    <header className="si-project-page-heading">
      <div className="si-project-title-line"><h1>{project.name}</h1><code>{project.domain} · {platformNames[project.platform]}</code></div>
      <div className="si-page-actions">
        <Button icon={<Tag size={15} />} onClick={() => setTagDialogOpen(true)}>标签管理</Button>
        <Button onClick={() => void exportCsv()}>导出 CSV</Button>
        <Button variant="primary" icon={<RefreshCw size={15} />} disabled={Boolean(activeRunId)} onClick={() => void runSync()}>{activeRunId ? "同步中…" : "立即同步"}</Button>
      </div>
    </header>
    <Tabs value="products" options={tabOptions} ariaLabel="项目页面" onChange={onTabChange} />
    <div className="si-products-filterbar">
      <span>库存</span>{stockOptions.map((option) => <FilterPill key={option.value} currentValue={stock} value={option.value} onValueChange={onStockChange}>{option.label}</FilterPill>)}
      <span>标签</span><FilterPill currentValue={tag} value="all" onValueChange={onTagChange}>全部</FilterPill>
      {(tagsQuery.data ?? []).map((item) => <FilterPill key={item.tag} currentValue={tag} value={item.tag} onValueChange={onTagChange}>{item.tag}</FilterPill>)}
      <span className="si-products-result-count">显示 {listQuery.data.total} 个产品</span>
    </div>
    {syncMessage && <div className="si-sync-progress" role="status">{syncMessage}</div>}
    {feedback && <p className="si-feedback" role="status">{feedback}</p>}
    <div className="si-products-table-frame">
      <DataTable
        tableId="products.list" scopeId={id}
        rows={listQuery.data.rows} total={listQuery.data.total} columns={columns}
        query={query} onQueryChange={setQuery} onRowClick={(row) => { setSelectedHandle(row.handle); setDetailFeedback(""); }}
        getRowId={(row) => row.handle} maxHeight={560} rowHeight={52} showPagination={false}
        emptyTitle="没有匹配的产品" emptyDescription="请修改搜索文字或库存、标签筛选条件。"
      />
      <p className="si-products-table-note">数据：index/views/products.jsonl · 点击产品查看详情 · 评分为示例值 · 灰色列为销量预留</p>
    </div>

    <DetailPanel open={Boolean(selectedHandle)} onClose={() => setSelectedHandle(null)} title={detail?.product.title ?? "产品详情"}>
      {detailQuery.isLoading ? <div className="si-page-loading" role="status">正在加载产品详情…</div> : detailQuery.isError || !detail ? <div className="si-page-error" role="alert">产品详情加载失败。<button type="button" onClick={() => void detailQuery.refetch()}>重试</button></div> : <ProductDetailContent
        detail={detail} tags={(tagsQuery.data ?? []).map((item) => item.tag)} isSaving={isSavingTags} feedback={detailFeedback}
        onAddTag={(name) => void updateTags([...detail.product.tags, name])}
        onCreateAndAddTag={(name) => void createAndAddTag(name)}
        onRemoveTag={(name) => void updateTags(detail.product.tags.filter((tagName) => tagName !== name))}
      />}
    </DetailPanel>

    <Dialog.Root open={tagDialogOpen} onOpenChange={setTagDialogOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="si-dialog-overlay" />
        <Dialog.Content className="si-confirm-dialog si-tag-manager-dialog">
          <div className="si-tag-manager-title"><Dialog.Title className="si-dialog-title">标签管理</Dialog.Title><Dialog.Close asChild><button type="button" className="si-icon-button" aria-label="关闭标签管理"><X size={16} /></button></Dialog.Close></div>
          <Dialog.Description className="si-dialog-description">为产品整理标签。删除标签前会再次确认。</Dialog.Description>
          <div className="si-tag-manager-create"><input aria-label="新标签名称" value={newTag} onChange={(event) => setNewTag(event.target.value)} placeholder="输入新标签名称" onKeyDown={(event) => { if (event.key === "Enter") void createManagedTag(); }} /><Button variant="primary" disabled={!newTag.trim()} onClick={() => void createManagedTag()}><Plus size={14} />创建标签</Button></div>
          {feedback && <p className="si-feedback" role="status">{feedback}</p>}
          <ul className="si-tag-manager-list">{(tagsQuery.data ?? []).map((item) => <li key={item.tag}><span className="si-product-tag">{item.tag}</span><small>{item.products} 个产品</small><Button size="small" variant="quiet" icon={<Trash2 size={14} />} onClick={() => setDeleteTag(item.tag)}>删除</Button></li>)}</ul>
          {!tagsQuery.data?.length && <div className="si-empty-state">暂无标签。</div>}
          <div className="si-dialog-actions"><Button onClick={() => setTagDialogOpen(false)}>完成</Button></div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
    <ConfirmDialog open={Boolean(deleteTag)} onOpenChange={(open) => { if (!open) setDeleteTag(null); }} title="删除标签？" description={deleteTag ? "将从所有“" + deleteTag + "”产品中移除该标签。" : "删除标签后无法恢复。"} confirmLabel="删除标签" tone="danger" onConfirm={removeManagedTag} />
  </div>;
}
