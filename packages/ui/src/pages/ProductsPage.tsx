import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { ExternalLink, Image as ImageIcon, Plus, Settings2, Tag, Trash2, X } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import type { ListQuery, ProductFilters, ProductFull, ProductVariantStock, ProductView, SkuGroupingRule, StockStatus } from "@siteindex/shared";
import { api, apiErrorMessage } from "../api";
import { projectQueryKeys } from "../project-queries";
import { ApiErrorNotice, Button, Chip, ConfirmDialog, DataTable, Drawer, FilterBar, FilterPill, Input, Notice, PageHeader, ProjectHeader, ProjectTabPanel, Select, StatusCells, stockTone, useToast } from "../components";
import { fetchSkuGroupingPreview, skuGroupingPreviewQueryKey } from "./project-settings-config/sku-grouping-preview";

const initialQuery: ListQuery<ProductFilters> = { page: 1, pageSize: 100, filters: {} };
const stockLabels: Record<StockStatus, string> = { in_stock: "有货", out_of_stock: "缺货", preorder: "预售", unknown: "未知" };
const stockOptions = [
  { value: "all", label: "全部" }, { value: "in", label: "有货" },
  { value: "out", label: "缺货" }, { value: "other", label: "预售 / 未知" },
] as const;


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
    : <span className="si-product-thumb-placeholder" role="img" aria-label="暂无商品图片" />;
}

function ProductPreview({ src, alt }: { src: string | null; alt: string }) {
  const [failed, setFailed] = useState(false);
  return <div className="si-product-detail-image">{src && !failed ? <img src={src} alt={alt} onError={() => setFailed(true)} /> : <ImageIcon size={32} aria-label="暂无商品图片" />}</div>;
}

function productColumns(): ColumnDef<ProductView, unknown>[] {
  return [
    { id: "product", accessorKey: "title", header: "产品", meta: { width: 320, grow: 2, minWidth: 240, text: "single" }, cell: ({ row }) => {
      const product = row.original;
      return <span className="si-product-main-cell">
        <ProductThumbnail src={product.image_url} />
        <span className="si-product-main-copy"><strong>{product.title}</strong><span><code>{product.handle}</code>{product.price_dropped_at && <Chip tone="warn">降价</Chip>}{product.restocked_at && <Chip tone="ok">到货</Chip>}{product.is_new && <Chip tone="info">新品</Chip>}</span></span>
      </span>;
    }, enableSorting: true },
    { id: "category", accessorKey: "category", header: "分类", meta: { width: 160, grow: 1, minWidth: 130, text: "single" }, cell: ({ row }) => <code className="si-mono">{row.original.category || "—"}</code>, enableSorting: true },
    { id: "price", accessorKey: "price_min", header: "价格", meta: { width: 100, grow: 0, minWidth: 88, align: "end", text: "single" }, cell: ({ row }) => priceCell(row.original), enableSorting: true },
    { id: "in_stock_variants", accessorKey: "in_stock_variants", header: "有货变体", meta: { width: 105, grow: 0, minWidth: 96, align: "end", text: "single" }, cell: ({ row }) => row.original.row_kind === "child" || typeof row.original.in_stock_variants !== "number" || typeof row.original.variant_count !== "number" ? "—" : row.original.in_stock_variants + "/" + row.original.variant_count, enableSorting: true },
    { id: "stock_status", accessorKey: "stock_status", header: "库存", meta: { width: 90, grow: 0, minWidth: 82, text: "single" }, cell: ({ row }) => <Chip tone={stockTone[row.original.stock_status]}>{stockLabels[row.original.stock_status]}</Chip>, enableSorting: true },
    { id: "tags", accessorKey: "tags", header: "标签", meta: { width: 170, grow: 0, minWidth: 146, text: "single" }, cell: ({ row }) => <span className="si-product-tags-cell">{row.original.tags.slice(0, 3).map((tag) => <span className="si-product-tag" key={tag}>{tag}</span>)}{row.original.exclude_edm === 1 && <span className="si-product-tag si-product-tag-warn">不进 EDM</span>}</span>, enableSorting: false },
    { id: "rating", accessorKey: "rating", header: "评分", meta: { width: 96, grow: 0, minWidth: 86, align: "end", text: "single" }, cell: ({ row }) => row.original.rating == null ? "—" : row.original.rating.toFixed(1) + (row.original.review_count ? " (" + row.original.review_count + ")" : ""), enableSorting: true },
    { id: "units_30d", accessorKey: "units_30d", header: "30天销量", cell: () => "—", enableSorting: false, meta: { width: 102, grow: 0, minWidth: 92, align: "end", reserved: true, text: "single" } },
    { id: "revenue_30d", accessorKey: "revenue_30d", header: "30天销售额", cell: () => "—", enableSorting: false, meta: { width: 128, grow: 0, minWidth: 112, align: "end", reserved: true, text: "single" } },
  ];
}

function formatRate(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : (value * 100).toFixed(0) + "%";
}

function productVariantColumns(): ColumnDef<ProductVariantStock, unknown>[] {
  return [
    { id: "sku", accessorKey: "sku", header: "SKU", meta: { width: 150, grow: 0, minWidth: 130, text: "single" }, cell: ({ row }) => <code>{row.original.sku}</code> },
    { id: "title", accessorKey: "title", header: "变体", meta: { width: 220, grow: 1, minWidth: 170, text: "clamp2" }, cell: ({ row }) => row.original.title || "默认变体" },
    { id: "stock_status", accessorKey: "stock_status", header: "库存", meta: { width: 94, grow: 0, minWidth: 88, text: "single" }, cell: ({ row }) => <Chip tone={stockTone[row.original.stock_status]}>{stockLabels[row.original.stock_status]}</Chip> },
    { id: "days_in_status", accessorKey: "days_in_status", header: "持续", meta: { width: 92, grow: 0, minWidth: 84, align: "end", text: "single" }, cell: ({ row }) => row.original.days_in_status + " 天" },
    { id: "history_30d", accessorKey: "history_30d", header: "近 30 天", meta: { width: 184, grow: 0, minWidth: 168, text: "single" }, cell: ({ row }) => <StatusCells history={row.original.history_30d} label={row.original.sku + "近 30 天库存"} /> },
    { id: "online_rate_30d", accessorKey: "online_rate_30d", header: "在线率", meta: { width: 90, grow: 0, minWidth: 80, align: "end", text: "single" }, cell: ({ row }) => formatRate(row.original.online_rate_30d) },
  ];
}

function ProductVariantInventory({ variants, handle }: { variants: ProductVariantStock[]; handle: string }) {
  const [query, setQuery] = useState<ListQuery>({ page: 1, pageSize: 50, filters: {} });
  const columns = useMemo(productVariantColumns, []);
  const start = query.pageSize === 0 ? 0 : (query.page - 1) * query.pageSize;
  const rows = query.pageSize === 0 ? variants : variants.slice(start, start + query.pageSize);
  return <DataTable
    tableId="products.variant-stock" scopeId={handle}
    rows={rows} total={variants.length} columns={columns}
    query={query} onQueryChange={setQuery} getRowId={(row) => row.sku}
    height={360} rowHeight={52}
    emptyTitle="暂无变体库存数据" emptyDescription="Core 尚未返回该产品的变体库存。"
  />;
}

function ProductGroupingPreview({ projectId, rule, enabled }: { projectId: string; rule: SkuGroupingRule; enabled: boolean }) {
  const previewQuery = useQuery({
    queryKey: skuGroupingPreviewQueryKey(projectId, rule),
    queryFn: () => fetchSkuGroupingPreview(api, projectId, rule),
    enabled,
    staleTime: 60_000,
  });
  const preview = previewQuery.data;
  return <div className="si-products-grouping-preview">
    <div className="si-products-grouping-rule"><span>当前规则</span><code>{rule.type} · {rule.value}</code></div>
    {previewQuery.isLoading ? <p role="status">正在通过 Core 计算 SKU 分组预览…</p>
      : previewQuery.isError ? <ApiErrorNotice label="SKU 分组预览加载失败。" error={previewQuery.error} onRetry={() => void previewQuery.refetch()} />
        : preview ? <>
          <div className="si-products-grouping-stats"><span><strong>{preview.parents}</strong> 个父 SKU</span><span>已匹配 <strong>{preview.children}</strong> 个子 SKU</span><span>未匹配 <strong>{preview.unmatched}</strong> 个</span></div>
          {preview.samples.length > 0 ? <ul>{preview.samples.slice(0, 6).map((sample) => <li key={sample.parent}><code>{sample.parent}</code><span>{sample.children.length} 个：{sample.children.slice(0, 4).join("、")}{sample.children.length > 4 ? " …" : ""}</span></li>)}</ul> : <p>当前规则没有可展示的分组样例。</p>}
          {preview.collisions?.length ? <details><summary>有 {preview.collisions.length} 组父 SKU 本身也在售，已跳过分组</summary><ul>{preview.collisions.map((collision) => <li key={collision.parent}><code>{collision.parent}</code><span>子 SKU：{collision.children.length ? collision.children.join("、") : "未提供明细"}</span></li>)}</ul></details> : null}
          <small>规则预览不代表父 SKU 的库存或在线率。</small>
        </> : <p role="status">正在准备 SKU 分组预览…</p>}
  </div>;
}

function ProductDetailContent({
  detail, tags, isSaving, onAddTag, onCreateAndAddTag, onRemoveTag,
}: {
  detail: ProductFull;
  tags: string[];
  isSaving: boolean;
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
    <p className="si-product-detail-handle"><code>{product.handle}</code> · 变体数 {product.variant_count ?? "—"}</p>
    <div className="si-product-detail-facts">
      <div><span>价格</span><strong>{priceLabel(product)}</strong></div>
      <div><span>库存</span><Chip tone={stockTone[product.stock_status]}>{stockLabels[product.stock_status]}</Chip></div>
      <div><span>评分</span><strong>{product.rating == null ? "—" : product.rating.toFixed(1) + (product.review_count ? " · " + product.review_count + " 条评价" : "")}</strong></div>
    </div>
    {detail.details?.short_description && <section><h4>商品简介</h4><p>{detail.details.short_description}</p></section>}
    <section className="si-product-detail-tag-section">
      <h4>标签</h4>
      <div className="si-product-detail-tags">{product.tags.length ? product.tags.map((tag) => <span className="si-product-tag" key={tag}>{tag}<button type="button" aria-label={"移除标签 " + tag} disabled={isSaving} onClick={() => onRemoveTag(tag)}><X size={12} /></button></span>) : <span className="si-muted">暂无标签</span>}</div>
      <div className="si-product-tag-editor"><Select ariaLabel="从已有标签中添加" value={existingTag} placeholder="选择已有标签" options={tags.filter((tag) => !product.tags.includes(tag)).map((tag) => ({ value: tag, label: tag }))} onValueChange={setExistingTag} /><Button size="small" disabled={!existingTag || isSaving} onClick={() => { onAddTag(existingTag); setExistingTag(""); }}><Plus size={13} />添加</Button></div>
      <div className="si-product-tag-editor"><Input aria-label="新建并添加标签" value={newTag} onChange={(event) => setNewTag(event.target.value)} placeholder="新建标签" /><Button size="small" disabled={!newTag.trim() || isSaving} onClick={() => { onCreateAndAddTag(newTag.trim()); setNewTag(""); }}><Plus size={13} />新建并添加</Button></div>
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
    <section className="si-product-variant-section">
      <h4>变体库存</h4>
      {detail.variants === undefined
        ? <Notice tone="warn" title="当前运行环境未提供变体库存">请更新桌面应用后重试。</Notice>
        : detail.variants.length > 0
          ? <ProductVariantInventory key={product.handle} variants={detail.variants} handle={product.handle} />
          : <p className="si-muted">暂无变体库存数据。</p>}
    </section>
  </div>;
}

export function ProductsPage() {
  const { id = "demo" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState<ListQuery<ProductFilters>>(initialQuery);
  const [selectedHandle, setSelectedHandle] = useState<string | null>(null);
  const [tagDialogOpen, setTagDialogOpen] = useState(false);
  const [groupingDrawerOpen, setGroupingDrawerOpen] = useState(false);
  const [newTag, setNewTag] = useState("");
  const [deleteTag, setDeleteTag] = useState<string | null>(null);
  const [isSavingTags, setIsSavingTags] = useState(false);
  const toast = useToast();
  const projectQuery = useQuery({ queryKey: projectQueryKeys.detail(id), queryFn: () => api.projects.get(id) });
  const listQuery = useQuery({ queryKey: ["products", id, query], queryFn: () => api.products.list(id, query), placeholderData: (previous) => previous });
  const tagsQuery = useQuery({ queryKey: ["product-tags", id], queryFn: () => api.products.listTags(id) });
  const detailQuery = useQuery({ queryKey: ["product", id, selectedHandle], queryFn: () => api.products.get(id, selectedHandle ?? ""), enabled: Boolean(selectedHandle) });
  const columns = useMemo(productColumns, []);
  const stock = query.filters?.stock ?? "all";
  const tag = query.filters?.tag ?? "all";
  const project = projectQuery.data?.summary;
  const skuGrouping = projectQuery.data?.config.sku_grouping;
  const groupingEnabled = skuGrouping?.enabled === true;
  const groupingRule: SkuGroupingRule = skuGrouping?.rule ?? { type: "separator", value: "-" };
  const detail = detailQuery.data;

  useEffect(() => {
    setQuery(initialQuery); setSelectedHandle(null); setTagDialogOpen(false); setGroupingDrawerOpen(false); setNewTag(""); setDeleteTag(null);
  }, [id]);

  const onStockChange = (value: string | undefined) => setQuery((current) => ({ ...current, page: 1, filters: { ...current.filters, stock: !value || value === "all" ? undefined : value as ProductFilters["stock"] } }));
  const onTagChange = (value: string | undefined) => setQuery((current) => ({ ...current, page: 1, filters: { ...current.filters, tag: !value || value === "all" ? undefined : value } }));
  const onParentOnlyChange = (checked: boolean) => {
    if (!groupingEnabled) {
      if (checked) setGroupingDrawerOpen(true);
      return;
    }
    setQuery((current) => ({ ...current, page: 1, filters: { ...current.filters, parent_only: checked || undefined } }));
  };
  const openGroupingSettings = () => {
    setGroupingDrawerOpen(false);
    navigate("/p/" + id + "/settings/config?section=sku-grouping");
  };

  const exportCsv = async () => {
    try { const path = await api.products.exportCsv(id, query); await api.shell.openPath(path); toast.success("产品 CSV 已导出。"); }
    catch (cause) { toast.error(apiErrorMessage(cause, "产品 CSV 导出失败。")); }
  };
  const updateTags = async (tags: string[]) => {
    if (!selectedHandle) return;
    setIsSavingTags(true);
    try {
      const saved = await api.products.setTags(id, selectedHandle, tags);
      queryClient.setQueryData<ProductFull>(["product", id, selectedHandle], (current) => current ? { ...current, product: { ...current.product, tags: saved } } : current);
      await Promise.all([queryClient.invalidateQueries({ queryKey: ["products", id] }), queryClient.invalidateQueries({ queryKey: ["product-tags", id] })]);
      toast.success("标签已保存。");
    } catch (cause) { toast.error(apiErrorMessage(cause, "标签保存失败。")); }
    finally { setIsSavingTags(false); }
  };
  const createAndAddTag = async (name: string) => {
    if (!selectedHandle || !name) return;
    setIsSavingTags(true);
    try {
      await api.products.createTag(id, name);
      const saved = await api.products.setTags(id, selectedHandle, [...(detail?.product.tags ?? []), name]);
      queryClient.setQueryData<ProductFull>(["product", id, selectedHandle], (current) => current ? { ...current, product: { ...current.product, tags: saved } } : current);
      await Promise.all([queryClient.invalidateQueries({ queryKey: ["products", id] }), queryClient.invalidateQueries({ queryKey: ["product-tags", id] })]);
      setNewTag("");
      toast.success("标签已创建并添加。");
    } catch (cause) { toast.error(apiErrorMessage(cause, "标签创建失败。")); }
    finally { setIsSavingTags(false); }
  };
  const createManagedTag = async () => {
    const name = newTag.trim();
    if (!name) return;
    try { await api.products.createTag(id, name); await queryClient.invalidateQueries({ queryKey: ["product-tags", id] }); setNewTag(""); toast.success("标签已创建。"); }
    catch (cause) { toast.error(apiErrorMessage(cause, "标签创建失败。")); }
  };
  const removeManagedTag = async () => {
    if (!deleteTag) return;
    try { await api.products.deleteTag(id, deleteTag); await Promise.all([queryClient.invalidateQueries({ queryKey: ["product-tags", id] }), queryClient.invalidateQueries({ queryKey: ["products", id] })]); setDeleteTag(null); toast.success("标签已删除。"); }
    catch (cause) { toast.error(apiErrorMessage(cause, "标签删除失败。")); }
  };

  if (projectQuery.isLoading) return <div className="si-page-loading" role="status">正在加载项目信息…</div>;
  if (projectQuery.isError || !project) return <ApiErrorNotice page label="项目产品页面加载失败。" error={projectQuery.error} onRetry={() => void projectQuery.refetch()} />;

  return <div className="si-page si-products-page">
    <ProjectHeader project={project} activeTab="products" hasTabPanel />
    <ProjectTabPanel projectId={project.id} tab="products">
    <PageHeader
      title="产品"
      meta={<Chip tone="neutral">{project.domain}</Chip>}
      actions={<Button variant="primary" onClick={() => void exportCsv()}>导出 CSV</Button>}
      overflow={[{ label: "SKU 父子规则设置", onSelect: openGroupingSettings, icon: <Settings2 size={14} /> }]}
    />
    <div className="si-products-filterbar">
      <FilterBar className="si-products-filter-conditions">
        <span className="si-products-filter-label">库存</span>{stockOptions.map((option) => <FilterPill key={option.value} currentValue={stock} value={option.value} onValueChange={onStockChange}>{option.label}</FilterPill>)}
        <span className="si-products-filter-label is-separated">标签</span><FilterPill currentValue={tag} value="all" onValueChange={onTagChange}>全部</FilterPill>
        {(tagsQuery.data ?? []).map((item) => <FilterPill key={item.tag} currentValue={tag} value={item.tag} onValueChange={onTagChange}>{item.tag}</FilterPill>)}
      </FilterBar>
      <label className="si-products-parent-toggle"><input type="checkbox" aria-label="仅展示父 SKU" checked={Boolean(query.filters?.parent_only && groupingEnabled)} onChange={(event) => onParentOnlyChange(event.target.checked)} /><span>仅展示父 SKU</span></label>
      <Button size="small" icon={<Tag size={14} />} onClick={() => setTagDialogOpen(true)}>标签管理</Button>
      {tagsQuery.isError && <ApiErrorNotice label="标签筛选加载失败。" error={tagsQuery.error} onRetry={() => void tagsQuery.refetch()} />}
      <span className="si-products-result-count">显示 {listQuery.data?.total ?? 0} 个产品</span>
    </div>
    <div className="si-products-table-frame">
      {listQuery.isLoading ? <div className="si-query-loading" role="status">正在加载产品列表…</div> : listQuery.isError ? <ApiErrorNotice label="产品列表加载失败。" error={listQuery.error} onRetry={() => void listQuery.refetch()} /> : <DataTable
        tableId="products.list" scopeId={id}
        rows={listQuery.data?.rows ?? []} total={listQuery.data?.total ?? 0} columns={columns}
        query={query} onQueryChange={setQuery} onRowClick={(row) => setSelectedHandle(row.handle)}
        getRowId={(row) => row.handle} height="fill" rowHeight={52}
        emptyTitle="没有匹配的产品" emptyDescription="请修改搜索文字或库存、标签筛选条件。"
      />}
      <p className="si-products-table-note">数据：index/views/products.jsonl · 点击产品查看详情 · 评分为示例值 · 灰色列为销量预留</p>
    </div>

    <Drawer open={Boolean(selectedHandle)} onOpenChange={(open) => { if (!open) setSelectedHandle(null); }} title={detail?.product.title ?? "产品详情"} width="wide">
      {detailQuery.isLoading ? <div className="si-query-loading" role="status">正在加载产品详情…</div> : detailQuery.isError ? <ApiErrorNotice label="产品详情加载失败。" error={detailQuery.error} onRetry={() => void detailQuery.refetch()} /> : detail ? <ProductDetailContent
        detail={detail} tags={(tagsQuery.data ?? []).map((item) => item.tag)} isSaving={isSavingTags}
        onAddTag={(name) => void updateTags([...detail.product.tags, name])}
        onCreateAndAddTag={(name) => void createAndAddTag(name)}
        onRemoveTag={(name) => void updateTags(detail.product.tags.filter((tagName) => tagName !== name))}
      /> : <div className="si-empty-state">没有找到该产品的详情。</div>}
    </Drawer>

    <Drawer open={tagDialogOpen} onOpenChange={setTagDialogOpen} title="标签管理" description="为产品整理标签。删除标签前会再次确认。" footer={<Button onClick={() => setTagDialogOpen(false)}>完成</Button>}>
      <div className="si-tag-manager-create"><Input aria-label="新标签名称" value={newTag} onChange={(event) => setNewTag(event.target.value)} placeholder="输入新标签名称" onKeyDown={(event) => { if (event.key === "Enter") void createManagedTag(); }} /><Button variant="primary" disabled={!newTag.trim()} onClick={() => void createManagedTag()}><Plus size={14} />创建标签</Button></div>
      {tagsQuery.isLoading ? <p className="si-muted" role="status">正在加载标签…</p> : tagsQuery.isError ? <ApiErrorNotice label="标签列表加载失败。" error={tagsQuery.error} onRetry={() => void tagsQuery.refetch()} /> : <>
        <ul className="si-tag-manager-list">{(tagsQuery.data ?? []).map((item) => <li key={item.tag}><span className="si-product-tag">{item.tag}</span><small>{item.products} 个产品</small><Button size="small" variant="quiet" icon={<Trash2 size={14} />} onClick={() => setDeleteTag(item.tag)}>删除</Button></li>)}</ul>
        {!tagsQuery.data?.length && <div className="si-empty-state">暂无标签。</div>}
      </>}
    </Drawer>
    <ConfirmDialog open={Boolean(deleteTag)} onOpenChange={(open) => { if (!open) setDeleteTag(null); }} title="删除标签？" description={deleteTag ? "将从所有“" + deleteTag + "”产品中移除该标签。" : "删除标签后无法恢复。"} confirmLabel="删除标签" tone="danger" onConfirm={removeManagedTag} />
    <Drawer open={groupingDrawerOpen} onOpenChange={setGroupingDrawerOpen} title="配置父子 SKU 规则" description="仅当项目启用分组后，产品列表才会筛选父 SKU。预览由 Core 计算。" footer={<div className="si-products-drawer-actions"><Button onClick={() => setGroupingDrawerOpen(false)}>关闭</Button><Button variant="primary" onClick={openGroupingSettings}>前往项目设置</Button></div>}>
      <Notice tone="warn" title="当前未启用父子 SKU 分组">“仅展示父 SKU”暂时不会改变产品列表。先在项目设置中启用规则，再返回这里筛选。</Notice>
      <ProductGroupingPreview projectId={id} rule={groupingRule} enabled={groupingDrawerOpen} />
    </Drawer>
    </ProjectTabPanel>
  </div>;
}
import "./products/page.css";
