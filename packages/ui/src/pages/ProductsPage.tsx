import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { Download, ExternalLink, FileText, Image as ImageIcon, MoreHorizontal, Plus, RefreshCw, Settings2, Tag, Trash2, TrendingUp, X } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { HistoryRange, InventorySummary, ListQuery, ProductFilters, ProductFull, ProductVariantStock, ProductView, SkuGroupingRule, SkuRecord, SkuStockFilters, SkuStockView, StockStatus, TagStat } from "@siteindex/shared";
import { api, apiErrorMessage } from "../api";
import { projectQueryKeys } from "../project-queries";
import { ApiErrorNotice, Button, Chip, ConfirmDialog, DataTable, Drawer, FilterBar, formatDateTime, Input, InputWithAction, KpiCard, Notice, ProjectHeader, ProjectTabPanel, SearchInput, Segmented, Select, useToast, stockTone } from "../components";
import { formatInventoryDetailDuration, formatInventoryTableDuration, InventoryHistoryCell, InventoryRateCell } from "./inventory/table-cells";
import { fetchSkuGroupingPreview, skuGroupingPreviewQueryKey } from "./project-settings-config/sku-grouping-preview";
import { CategoryPanel, GroupingPreview, historyRanges, requestInventorySummary, stockNames, TrendChart } from "./products/inventory-widgets";
import { formatInStockVariants, formatProductPrice, matchesProductManagementSearch, mergeProductAndStockRows, type ProductManagementRow } from "./products/merged-rows";

const stockOptions = [
  { value: "all", label: "全部" }, { value: "in_stock", label: "有货" }, { value: "out_of_stock", label: "缺货" },
  { value: "preorder", label: "预售" }, { value: "unknown", label: "未知" }, { value: "today", label: "今日有变化" },
] as const;
const priceOptions = [
  { value: "none", label: "全部价格" }, { value: "30", label: "近 30 天" }, { value: "60", label: "近 60 天" },
  { value: "90", label: "近 90 天" }, { value: "all", label: "有历史变动" },
] as const;
type ProductManagementFilters = ProductFilters & Pick<SkuStockFilters, "status" | "watched_only" | "price_changed_within">;
type ProductManagementQuery = ListQuery<ProductManagementFilters>;
type DrawerSegment = "overview" | "variants" | "history";
type DrawerVariant = { sku: string; title: string; stock: SkuStockView | null; record: SkuRecord | null; variant: ProductVariantStock | null };

function initialQuery(): ProductManagementQuery { return { page: 1, pageSize: 50, filters: { parent_only: true } }; }

function productColumns(onOpen: (row: ProductManagementRow) => void, onOpenUrl: (url: string) => void): ColumnDef<ProductManagementRow, unknown>[] {
  return [
    { id: "product", accessorFn: (row) => row.product.title, header: "产品 / SKU", meta: { width: 290, grow: 2, minWidth: 220, text: "single" }, cell: ({ row }) => {
      const item = row.original;
      const product = item.product;
      const sku = item.sku ?? "—";
      return <span className="si-product-main-cell">
        <ProductThumbnail src={product.image_url} />
        <span className="si-product-main-copy"><strong>{product.title}</strong><span>
          <code className="si-product-sku" title={sku}>SKU {sku}</code>
          {item.kind === "parent" && <Chip tone="info">父 SKU</Chip>}
          {item.kind === "child" && <Chip tone="neutral">子 SKU</Chip>}
          {product.status === "removed" && <Chip tone="neutral">已下架</Chip>}
          {product.price_dropped_at && <Chip tone="warn">降价</Chip>}
          {product.restocked_at && <Chip tone="ok">到货</Chip>}
          {product.is_new && <Chip tone="info">新品</Chip>}
          {product.handle && <code>{product.handle}</code>}
        </span></span>
      </span>;
    }, enableSorting: true },
    { id: "stock_status", accessorFn: (row) => row.stock?.stock_status ?? row.product.stock_status, header: "库存状态", meta: { width: 108, grow: 0, minWidth: 100, text: "single" }, cell: ({ row }) => {
      const status = row.original.stock?.stock_status ?? row.original.product.stock_status;
      return <Chip tone={stockTone[status]}>{stockNames[status]}</Chip>;
    }, enableSorting: true },
    { id: "days_in_status", accessorFn: (row) => row.stock?.days_in_status ?? null, header: "持续", meta: { width: 88, grow: 0, minWidth: 80, align: "end", text: "single" }, cell: ({ row }) => row.original.stock ? formatInventoryTableDuration(row.original.stock) : "—", enableSorting: true },
    { id: "online_rate_30d", accessorFn: (row) => row.stock?.online_rate_30d ?? null, header: "30 天在线率", meta: { width: 132, grow: 0, minWidth: 120, align: "end", text: "single" }, cell: ({ row }) => <InventoryRateCell value={row.original.stock?.online_rate_30d} />, enableSorting: true },
    { id: "history_30d", accessorFn: (row) => row.stock?.history_30d ?? "", header: "近 30 天趋势", meta: { width: 176, grow: 0, minWidth: 160, text: "single" }, cell: ({ row }) => row.original.stock ? <InventoryHistoryCell row={row.original.stock} /> : "—", enableSorting: false },
    { id: "in_stock_variants", accessorFn: (row) => row.product.in_stock_variants, header: "有货变体", meta: { width: 104, grow: 0, minWidth: 96, align: "end", text: "single" }, cell: ({ row }) => formatInStockVariants(row.original), enableSorting: true },
    { id: "price", accessorFn: (row) => row.kind === "parent" ? row.product.price_min : row.stock?.price ?? row.product.price_min, header: "价格", meta: { width: 112, grow: 0, minWidth: 96, align: "end", text: "single" }, cell: ({ row }) => <span className="si-mono">{formatProductPrice(row.original)}</span>, enableSorting: true },
    { id: "category", accessorFn: (row) => row.stock?.category ?? row.product.category, header: "分类", meta: { width: 142, grow: 1, minWidth: 120, text: "single" }, cell: ({ row }) => <code className="si-mono">{(row.original.stock?.category ?? row.original.product.category) || "—"}</code>, enableSorting: true },
    { id: "last_change", accessorFn: (row) => row.stock?.last_change_at ?? null, header: "最近变化", meta: { width: 158, grow: 1, minWidth: 140, text: "clamp2" }, cell: ({ row }) => row.original.stock?.last_change ? <span className="si-products-last-change"><strong>{row.original.stock.last_change_at ?? "近期"}</strong><small>{row.original.stock.last_change}</small></span> : <span className="si-muted">—</span>, enableSorting: true },
    { id: "rating", accessorFn: (row) => row.product.rating ?? null, header: "评分 / 评价数", meta: { width: 126, grow: 0, minWidth: 116, align: "end", text: "single" }, cell: ({ row }) => row.original.product.rating == null && row.original.product.review_count == null ? "—" : `${row.original.product.rating == null ? "—" : row.original.product.rating.toFixed(1)} · ${row.original.product.review_count ?? "—"}`, enableSorting: true },
    { id: "link", accessorFn: (row) => row.product.url, header: "链接", meta: { width: 76, grow: 0, minWidth: 72, text: "single" }, cell: ({ row }) => <Button size="small" variant="quiet" icon={<ExternalLink size={13} />} aria-label={`打开 ${row.original.product.title} 商品页`} onClick={(event) => { event.stopPropagation(); onOpenUrl(row.original.product.url); }}>打开</Button>, enableSorting: false },
    { id: "actions", header: "操作", meta: { width: 56, grow: 0, minWidth: 56, sticky: "right", text: "single" }, cell: ({ row }) => <Button size="small" variant="quiet" icon={<MoreHorizontal size={15} />} aria-label={`查看 ${row.original.sku ?? row.original.product.title} 详情`} onClick={(event) => { event.stopPropagation(); onOpen(row.original); }} />, enableSorting: false },
  ];
}

function ProductThumbnail({ src }: { src: string | null }) {
  const [failed, setFailed] = useState(false);
  return src && !failed ? <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} /> : <span className="si-product-thumb-placeholder" role="img" aria-label="暂无商品图片" />;
}

function ProductPreview({ src, alt }: { src: string | null; alt: string }) {
  const [failed, setFailed] = useState(false);
  return <div className="si-product-detail-image">{src && !failed ? <img src={src} alt={alt} onError={() => setFailed(true)} /> : <ImageIcon size={32} aria-label="暂无商品图片" />}</div>;
}

function priceLabel(product: ProductView): string {
  if (product.price_min === null) return "—";
  if (product.price_max === null || product.price_min === product.price_max) return product.price_min.toFixed(2);
  return product.price_min.toFixed(2) + "–" + product.price_max.toFixed(2);
}

function removedSkuReason(sku: SkuRecord): string | null {
  if (sku.status !== "removed") return null;
  if (sku.removed_reason === "feed_absent_404") return "商品页不存在（404/410）";
  if (sku.removed_reason === "feed_absent_aged") return "连续多次未见于 Feed";
  return "已从商品 Feed 移除";
}

function buildDrawerVariants(detail: ProductFull, allStockRows: readonly SkuStockView[]): DrawerVariant[] {
  const stockBySku = new Map(allStockRows.map((row) => [row.sku, row]));
  const records = new Map(detail.skus.map((row) => [row.sku, row]));
  const variants = detail.variants ?? [];
  const rows: DrawerVariant[] = variants.map((variant) => ({
    sku: variant.sku,
    title: variant.title || records.get(variant.sku)?.variant_title || "默认变体",
    stock: stockBySku.get(variant.sku) ?? null,
    record: records.get(variant.sku) ?? null,
    variant,
  }));
  const seen = new Set(rows.map((row) => row.sku));
  for (const record of detail.skus) {
    if (seen.has(record.sku)) continue;
    rows.push({ sku: record.sku, title: record.variant_title || "默认变体", stock: stockBySku.get(record.sku) ?? null, record, variant: null });
  }
  return rows.sort((left, right) => left.sku.localeCompare(right.sku));
}

function drawerVariantColumns(): ColumnDef<DrawerVariant, unknown>[] {
  return [
    { id: "sku", accessorKey: "sku", header: "SKU", meta: { width: 158, grow: 0, minWidth: 138, text: "single" }, cell: ({ row }) => <code>{row.original.sku}</code>, enableSorting: true },
    { id: "title", accessorKey: "title", header: "变体", meta: { width: 190, grow: 1, minWidth: 160, text: "clamp2" }, cell: ({ row }) => <span>{row.original.title}{removedSkuReason(row.original.record ?? ({ status: "active" } as SkuRecord)) && <small className="si-product-sku-reason">{removedSkuReason(row.original.record!)}</small>}</span>, enableSorting: true },
    { id: "stock_status", accessorFn: (row) => row.stock?.stock_status ?? row.variant?.stock_status ?? null, header: "库存", meta: { width: 92, grow: 0, minWidth: 84, text: "single" }, cell: ({ row }) => {
      const status = row.original.stock?.stock_status ?? row.original.variant?.stock_status;
      return status ? <Chip tone={stockTone[status]}>{stockNames[status]}</Chip> : <span className="si-muted">—</span>;
    } },
    { id: "days_in_status", accessorFn: (row) => row.stock?.days_in_status ?? row.variant?.days_in_status ?? null, header: "持续", meta: { width: 86, grow: 0, minWidth: 78, align: "end", text: "single" }, cell: ({ row }) => row.original.stock ? formatInventoryDetailDuration(row.original.stock) : row.original.variant ? `${row.original.variant.days_in_status} 天` : "—" },
    { id: "online_rate_30d", accessorFn: (row) => row.stock?.online_rate_30d ?? row.variant?.online_rate_30d ?? null, header: "30 天在线率", meta: { width: 116, grow: 0, minWidth: 104, align: "end", text: "single" }, cell: ({ row }) => <InventoryRateCell value={row.original.stock?.online_rate_30d ?? row.original.variant?.online_rate_30d} /> },
    { id: "history_30d", accessorFn: (row) => row.stock?.history_30d ?? row.variant?.history_30d ?? "", header: "近 30 天", meta: { width: 174, grow: 0, minWidth: 156, text: "single" }, cell: ({ row }) => row.original.stock ? <InventoryHistoryCell row={row.original.stock} /> : row.original.variant ? <span className="si-status-cells-text">{row.original.variant.history_30d}</span> : <span className="si-muted">—</span> },
  ];
}

function ProductVariantInventory({ variants }: { variants: DrawerVariant[] }) {
  const [query, setQuery] = useState<ListQuery>({ page: 1, pageSize: 50, filters: {} });
  const columns = useMemo(drawerVariantColumns, []);
  const start = query.pageSize === 0 ? 0 : (query.page - 1) * query.pageSize;
  const rows = query.pageSize === 0 ? variants : variants.slice(start, start + query.pageSize);
  return <DataTable tableId="products.variant-stock" rows={rows} total={variants.length} columns={columns} query={query} onQueryChange={setQuery} getRowId={(row) => row.sku} height={360} rowHeight={52} emptyTitle="暂无变体库存数据" emptyDescription="Core 尚未返回该产品的变体库存。" />;
}

function ProductOverview({ detail, row, tags, isSaving, onAddTag, onCreateAndAddTag, onRemoveTag, onOpenUrl }: {
  detail: ProductFull;
  row: ProductManagementRow;
  tags: string[];
  isSaving: boolean;
  onAddTag: (tag: string) => void;
  onCreateAndAddTag: (tag: string) => void;
  onRemoveTag: (tag: string) => void;
  onOpenUrl: (url: string) => void;
}) {
  const [existingTag, setExistingTag] = useState("");
  const [newTag, setNewTag] = useState("");
  const product = detail.product;
  const image = product.manual_image_url ?? product.feed_image_url ?? product.image_url ?? detail.details?.gallery[0] ?? null;
  const schemas = detail.seo?.schema_types ?? [];
  return <div className="si-product-detail">
    <ProductPreview src={image} alt={product.title} />
    <div className="si-product-detail-title"><span>{product.category || "未分类"}</span><Button size="small" variant="quiet" icon={<ExternalLink size={12} />} onClick={() => onOpenUrl(product.url)}>打开商品页</Button></div>
    <h3>{product.title}</h3>
    <p className="si-product-detail-handle"><code>{row.sku ?? product.handle}</code> · handle <code>{product.handle}</code> · 变体数 {product.variant_count ?? "—"}</p>
    <div className="si-product-detail-facts">
      <div><span>价格</span><strong>{formatProductPrice(row)}</strong></div>
      <div><span>库存</span><Chip tone={stockTone[row.stock?.stock_status ?? product.stock_status]}>{stockNames[row.stock?.stock_status ?? product.stock_status]}</Chip></div>
      <div><span>有货变体</span><strong>{formatInStockVariants(row)}</strong></div>
      <div><span>评分 / 评价数</span><strong>{product.rating == null ? "—" : product.rating.toFixed(1)}{product.review_count == null ? "" : ` / ${product.review_count}`}</strong></div>
      <div><span>最近变化</span><strong>{row.stock?.last_change ?? "—"}</strong></div>
      <div><span>变化日期</span><strong>{row.stock?.last_change_at ?? "—"}</strong></div>
    </div>
    {detail.details?.short_description && <section><h4>商品简介</h4><p>{detail.details.short_description}</p></section>}
    <section className="si-product-detail-tag-section">
      <h4>标签</h4>
      <div className="si-product-detail-tags">{product.tags.length ? product.tags.map((tag) => <span className="si-product-tag" key={tag}>{tag}<button type="button" aria-label={`移除标签 ${tag}`} disabled={isSaving} onClick={() => onRemoveTag(tag)}><X size={12} /></button></span>) : <span className="si-muted">暂无标签</span>}</div>
      <InputWithAction className="si-product-tag-editor" action={<Button disabled={!existingTag || isSaving} onClick={() => { onAddTag(existingTag); setExistingTag(""); }}><Plus size={13} />添加</Button>}><Select ariaLabel="从已有标签中添加" value={existingTag} placeholder="选择已有标签" options={tags.filter((tag) => !product.tags.includes(tag)).map((tag) => ({ value: tag, label: tag }))} onValueChange={setExistingTag} /></InputWithAction>
      <InputWithAction className="si-product-tag-editor" action={<Button disabled={!newTag.trim() || isSaving} onClick={() => { onCreateAndAddTag(newTag.trim()); setNewTag(""); }}><Plus size={13} />新建并添加</Button>}><Input aria-label="新建并添加标签" value={newTag} onChange={(event) => setNewTag(event.target.value)} placeholder="新建标签" /></InputWithAction>
    </section>
    <section>
      <h4>SEO 与 Google 收录</h4>
      {detail.seo ? <div className="si-product-seo-detail">
        <div><span>Title</span><p>{detail.seo.title || "—"}</p></div>
        <div><span>Robots</span><p>{detail.seo.robots_meta || "默认可索引"}</p></div>
        <div><span>Schema</span><div className="si-product-schema-list">{schemas.length ? schemas.map((schema) => <span className="si-product-schema-pill" key={schema}>{schema}</span>) : <span className="si-muted">未检测到 Schema</span>}</div></div>
        <div><span>Google 收录</span><p>{detail.seo.google_indexed === true ? "已收录" : detail.seo.google_indexed === false ? "未收录" : "未检查"}</p></div>
      </div> : <p className="si-muted">暂无 SEO 页面数据。</p>}
    </section>
  </div>;
}

function HistoryContent({ row, variants, selectedSku, onSelectedSkuChange, loading, error, onRetry }: {
  row: ProductManagementRow;
  variants: DrawerVariant[];
  selectedSku: string;
  onSelectedSkuChange: (sku: string) => void;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  const [range, setRange] = useState<HistoryRange>(30);
  const selectedVariant = variants.find((item) => item.sku === selectedSku);
  const pricePoints = selectedVariant?.stock?.price_history ?? [];
  const latestPriceDate = pricePoints.at(-1)?.date;
  const cutoff = range === "all" || !latestPriceDate ? null : Date.parse(latestPriceDate) - Number(range) * 86_400_000;
  const visiblePrices = pricePoints.filter((point) => cutoff === null || Date.parse(point.date) >= cutoff).map((point) => ({ date: point.date.slice(5), price: point.price }));
  return <div className="si-product-history">
    {row.stock ? <section className="si-product-history-section"><h4>库存历史 · {row.sku ?? "产品"}</h4><div className="si-product-history-facts"><span>当前状态持续：{formatInventoryDetailDuration(row.stock)}</span><span>7 天在线率：{row.stock.online_rate_7d == null ? "—" : `${(row.stock.online_rate_7d * 100).toFixed(0)}%`}</span><span>30 天在线率：{row.stock.online_rate_30d == null ? "—" : `${(row.stock.online_rate_30d * 100).toFixed(0)}%`}</span><span>30 天状态变化：{row.stock.changes_30d} 次</span><span>最近变化：{row.stock.last_change ?? "无变化"}</span><span>最近变化日期：{row.stock.last_change_at ?? "—"}</span></div><InventoryHistoryCell row={row.stock} /></section> : <p className="si-muted">Core 尚未返回该 SKU 的库存历史。</p>}
    <section className="si-product-history-section">
      <div className="si-stock-chart-heading"><h3>子 SKU 价格历史</h3><Select ariaLabel="价格历史 SKU" value={selectedSku} options={variants.map((item) => ({ value: item.sku, label: item.sku }))} onValueChange={onSelectedSkuChange} />
        <Select ariaLabel="价格历史范围" value={String(range)} onValueChange={(value) => setRange(value === "all" ? "all" : Number(value) as 30 | 60 | 90)} options={historyRanges.map((item) => ({ value: String(item.value), label: item.label }))} />
      </div>
      {loading ? <p role="status">正在加载 SKU 历史…</p> : error ? <ApiErrorNotice label="SKU 历史加载失败。" error={error} onRetry={onRetry} /> : visiblePrices.length > 0 ? <div className="si-product-history-plot"><ResponsiveContainer width="100%" height="100%"><LineChart data={visiblePrices} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}><CartesianGrid stroke="var(--color-line-soft)" vertical={false} /><XAxis dataKey="date" tick={{ fill: "var(--color-muted)", fontSize: "var(--fs-caption)" }} tickLine={false} axisLine={false} /><YAxis width={48} tick={{ fill: "var(--color-muted)", fontSize: "var(--fs-caption)" }} tickLine={false} axisLine={false} /><Tooltip formatter={(value) => [typeof value === "number" ? value.toFixed(2) : "—", "价格"]} /><Line type="monotone" dataKey="price" name="价格" stroke="var(--color-chart-feeders)" strokeWidth={2} dot={visiblePrices.length === 1 ? { r: 3 } : false} activeDot={{ r: 3 }} isAnimationActive={false} /></LineChart></ResponsiveContainer></div> : <p className="si-muted">所选 SKU 暂无价格历史。</p>}
      {row.kind === "parent" && <p className="si-muted">父 SKU 没有独立价格历史；此处按所选子 SKU 显示，不推算父级价格趋势。</p>}
    </section>
  </div>;
}

function csvField(value: unknown): string {
  const text = value == null ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function ProductTagManager({ tagsQuery, newTag, setNewTag, onCreate, onDelete }: {
  tagsQuery: { data?: TagStat[]; error: unknown; isLoading: boolean; isError: boolean; refetch: () => Promise<unknown> };
  newTag: string;
  setNewTag: (value: string) => void;
  onCreate: () => void;
  onDelete: (tag: string) => void;
}) {
  return <>
    <InputWithAction className="si-tag-manager-create" action={<Button variant="primary" disabled={!newTag.trim()} onClick={onCreate}><Plus size={14} />创建标签</Button>}><Input aria-label="新标签名称" value={newTag} onChange={(event) => setNewTag(event.target.value)} placeholder="输入新标签名称" onKeyDown={(event) => { if (event.key === "Enter") onCreate(); }} /></InputWithAction>
    {tagsQuery.isLoading ? <p className="si-muted" role="status">正在加载标签…</p> : tagsQuery.isError ? <ApiErrorNotice label="标签列表加载失败。" error={tagsQuery.error} onRetry={() => void tagsQuery.refetch()} /> : <>
      <ul className="si-tag-manager-list">{(tagsQuery.data ?? []).map((item) => <li key={item.tag}><span className="si-product-tag">{item.tag}</span><small>{item.products} 个产品</small><Button size="small" variant="quiet" icon={<Trash2 size={14} />} onClick={() => onDelete(item.tag)}>删除</Button></li>)}</ul>
      {!tagsQuery.data?.length && <div className="si-empty-state">暂无标签。</div>}
    </>}
  </>;
}

export function ProductsPage() {
  const { id = "demo" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [query, setQuery] = useState<ProductManagementQuery>(initialQuery);
  const [selectedRow, setSelectedRow] = useState<ProductManagementRow | null>(null);
  const [drawerSegment, setDrawerSegment] = useState<DrawerSegment>("overview");
  const [selectedHistorySku, setSelectedHistorySku] = useState("");
  const [historyRange, setHistoryRange] = useState<HistoryRange>(30);
  const [trendSelection, setTrendSelection] = useState<{ projectId: string; categories: string[] } | null>(null);
  const [showDefaultCategories, setShowDefaultCategories] = useState<boolean | null>(null);
  const [categoriesExpanded, setCategoriesExpanded] = useState(false);
  const [trendDrawerOpen, setTrendDrawerOpen] = useState(false);
  const [groupingDrawerOpen, setGroupingDrawerOpen] = useState(false);
  const [tagDialogOpen, setTagDialogOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [report, setReport] = useState<string | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportError, setReportError] = useState<unknown>(null);
  const [newTag, setNewTag] = useState("");
  const [deleteTag, setDeleteTag] = useState<string | null>(null);
  const [isSavingTags, setIsSavingTags] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [syncMessage, setSyncMessage] = useState("");

  const projectQuery = useQuery({ queryKey: projectQueryKeys.detail(id), queryFn: () => api.projects.get(id) });
  const parentOnly = Boolean(query.filters?.parent_only);
  const productListQuery = useQuery({
    queryKey: ["products-merged", id, parentOnly, query.filters?.tag],
    queryFn: () => api.products.list(id, { page: 1, pageSize: 0, filters: { parent_only: parentOnly || undefined, tag: query.filters?.tag } }),
    placeholderData: (previous) => previous,
  });
  const inventoryListQuery = useQuery({
    queryKey: ["inventory-skus-merged", id, parentOnly, query.filters?.status, query.filters?.watched_only, query.filters?.price_changed_within],
    queryFn: () => api.inventory.listSkus(id, { page: 1, pageSize: 0, filters: {
      parent_only: parentOnly || undefined,
      status: query.filters?.status,
      watched_only: query.filters?.watched_only,
      price_changed_within: query.filters?.price_changed_within,
    } }),
    placeholderData: (previous) => previous,
  });
  const tagsQuery = useQuery({ queryKey: ["product-tags", id], queryFn: () => api.products.listTags(id) });
  const detailQuery = useQuery({ queryKey: ["product", id, selectedRow?.product.handle], queryFn: () => api.products.get(id, selectedRow?.product.handle ?? ""), enabled: Boolean(selectedRow) });
  const detailStockQuery = useQuery({ queryKey: ["inventory-detail-skus", id], queryFn: () => api.inventory.listSkus(id, { page: 1, pageSize: 0, filters: {} }), enabled: Boolean(selectedRow), staleTime: 60_000 });
  const summaryQuery = useQuery({ queryKey: ["inventory-summary", id, historyRange], queryFn: () => requestInventorySummary(id, historyRange) });
  const openExternal = async (url: string) => {
    try { await api.shell.openExternal(url); toast.success("已打开商品页。"); }
    catch (cause) { toast.error(apiErrorMessage(cause, "无法打开商品页。")); }
  };
  const columns = useMemo(() => productColumns((row) => { setSelectedRow(row); setDrawerSegment("overview"); }, (url) => void openExternal(url)), []);
  const project = projectQuery.data?.summary;
  const config = projectQuery.data?.config;
  const watchedCategories = config?.categories.watched ?? [];
  const groupingEnabled = config?.sku_grouping?.enabled === true;
  const groupingRule: SkuGroupingRule = config?.sku_grouping?.rule ?? { type: "separator", value: "-" };
  const selectedTrendCategories = trendSelection?.projectId === id ? trendSelection.categories : null;
  const displayDefaultCategories = showDefaultCategories ?? watchedCategories.length === 0;
  const summary = summaryQuery.data;
  const allStockRows = inventoryListQuery.data?.rows ?? [];
  const productRows = productListQuery.data?.rows ?? [];
  const needsInventoryMatch = Boolean(query.filters?.status || query.filters?.watched_only || query.filters?.price_changed_within);
  const mergedRows = useMemo(() => mergeProductAndStockRows(productRows, allStockRows, needsInventoryMatch)
    .filter((row) => !query.filters?.category || row.product.categories.includes(query.filters.category) || row.product.category === query.filters.category || row.stock?.category === query.filters.category)
    .filter((row) => matchesProductManagementSearch(row, query.search ?? "")),
  [allStockRows, needsInventoryMatch, productRows, query.filters?.category, query.search]);
  const sortedRows = useMemo(() => {
    const sort = query.sort;
    if (!sort) return mergedRows;
    const value = (row: ProductManagementRow): string | number | null => {
      switch (sort.field) {
        case "product": return row.product.title;
        case "stock_status": return row.stock?.stock_status ?? row.product.stock_status;
        case "days_in_status": return row.stock?.days_in_status ?? null;
        case "online_rate_30d": return row.stock?.online_rate_30d ?? null;
        case "in_stock_variants": return row.product.in_stock_variants;
        case "price": return row.kind === "parent" ? row.product.price_min : row.stock?.price ?? row.product.price_min;
        case "category": return row.stock?.category ?? row.product.category;
        case "last_change": return row.stock?.last_change_at ?? null;
        case "rating": return row.product.rating ?? null;
        default: return row.sku ?? row.product.handle;
      }
    };
    return mergedRows.map((row, index) => ({ row, index })).sort((left, right) => {
      const a = value(left.row);
      const b = value(right.row);
      const result = a == null ? (b == null ? 0 : 1) : b == null ? -1 : typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b), "zh-CN", { numeric: true });
      return (sort.dir === "desc" ? -result : result) || left.index - right.index;
    }).map(({ row }) => row);
  }, [mergedRows, query.sort]);
  const start = query.pageSize === 0 ? 0 : (query.page - 1) * query.pageSize;
  const tableRows = query.pageSize === 0 ? sortedRows : sortedRows.slice(start, start + query.pageSize);
  const categoryOptions = [...new Set(productRows.flatMap((row) => [...row.categories, row.category]).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-CN"));
  const detail = detailQuery.data;
  const drawerVariants = useMemo(() => detail ? buildDrawerVariants(detail, detailStockQuery.data?.rows ?? []) : [], [detail, detailStockQuery.data?.rows]);

  useEffect(() => {
    setQuery(initialQuery()); setSelectedRow(null); setDrawerSegment("overview"); setSelectedHistorySku(""); setHistoryRange(30); setTrendSelection(null); setShowDefaultCategories(null); setCategoriesExpanded(false); setTrendDrawerOpen(false); setGroupingDrawerOpen(false); setTagDialogOpen(false); setReportOpen(false); setDeleteTag(null);
  }, [id]);
  useEffect(() => {
    if (!activeRunId) return;
    const unsubscribeProgress = api.jobs.onProgress((progress) => { if (progress.runId === activeRunId) setSyncMessage(progress.message); });
    const unsubscribeFinished = api.jobs.onFinished((result) => {
      if (result.runId !== activeRunId) return;
      setSyncMessage(""); setActiveRunId(null);
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ["inventory-summary", id] }),
        queryClient.invalidateQueries({ queryKey: ["inventory-skus-merged", id] }),
        queryClient.invalidateQueries({ queryKey: ["inventory-detail-skus", id] }),
        queryClient.invalidateQueries({ queryKey: ["products-merged", id] }),
      ]);
      if (result.status === "ok") toast.success("库存同步已完成。");
      else toast.error(result.summary || "库存同步失败。");
    });
    return () => { unsubscribeProgress(); unsubscribeFinished(); };
  }, [activeRunId, id, queryClient, toast]);

  const onSearch = (search: string) => setQuery((current) => ({ ...current, page: 1, search: search || undefined }));
  const onFilter = <K extends keyof ProductManagementFilters>(key: K, value: ProductManagementFilters[K] | undefined) => setQuery((current) => ({ ...current, page: 1, filters: { ...current.filters, [key]: value } }));
  const onTableQueryChange = (next: ProductManagementQuery) => setQuery((current) => ({ ...next, search: current.search, filters: current.filters }));
  const onViewChange = (value: "parent" | "child") => onFilter("parent_only", value === "parent");

  const exportCsv = () => {
    try {
      const headers = ["SKU", "产品", "库存状态", "持续", "30 天在线率", "30 天趋势", "有货变体", "价格", "分类", "链接", "标签", "评分", "评价数", "最近变化", "变化日期"];
      const values = sortedRows.map((row) => [
        row.sku, row.product.title, stockNames[row.stock?.stock_status ?? row.product.stock_status], row.stock ? formatInventoryTableDuration(row.stock) : "—",
        row.stock?.online_rate_30d == null ? "—" : `${(row.stock.online_rate_30d * 100).toFixed(0)}%`, row.stock?.history_30d ?? "—", formatInStockVariants(row), formatProductPrice(row),
        row.stock?.category ?? row.product.category, row.product.url, row.product.tags.join("、"), row.product.rating ?? "—", row.product.review_count ?? "—", row.stock?.last_change ?? "—", row.stock?.last_change_at ?? "—",
      ]);
      const csv = "\uFEFF" + [headers, ...values].map((line) => line.map(csvField).join(",")).join("\r\n");
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = `${id}-products.csv`; anchor.click();
      URL.revokeObjectURL(url);
      toast.success("产品管理 CSV 已导出。");
    } catch (cause) { toast.error(apiErrorMessage(cause, "产品管理 CSV 导出失败。")); }
  };
  const runSync = async () => {
    if (!project) return;
    try { setSyncMessage("正在启动库存同步…"); const run = await api.jobs.run({ projectPath: project.path, job: "daily" }); setActiveRunId(run.runId); }
    catch (cause) { setSyncMessage(""); toast.error(apiErrorMessage(cause, "同步任务启动失败。")); }
  };
  const loadReport = async () => {
    setReportLoading(true); setReportError(null);
    try { setReport(await api.inventory.dailyReport(id, summary?.as_of ?? new Date().toISOString().slice(0, 10))); }
    catch (cause) { setReportError(cause); }
    finally { setReportLoading(false); }
  };
  const openReport = async () => { setReportOpen(true); await loadReport(); };
  const openGroupingSettings = () => { setGroupingDrawerOpen(false); navigate(`/p/${id}/settings/config?section=sku-grouping`); };
  const openCategorySettings = () => { setTrendDrawerOpen(false); navigate(`/p/${id}/settings/config?section=watched-categories`); };

  const updateTags = async (tags: string[]) => {
    if (!detail) return;
    setIsSavingTags(true);
    try {
      const saved = await api.products.setTags(id, detail.product.handle, tags);
      queryClient.setQueryData<ProductFull>(["product", id, detail.product.handle], (current) => current ? { ...current, product: { ...current.product, tags: saved } } : current);
      await Promise.all([queryClient.invalidateQueries({ queryKey: ["products-merged", id] }), queryClient.invalidateQueries({ queryKey: ["product-tags", id] })]);
      toast.success("标签已保存。");
    } catch (cause) { toast.error(apiErrorMessage(cause, "标签保存失败。")); }
    finally { setIsSavingTags(false); }
  };
  const createAndAddTag = async (name: string) => {
    if (!detail || !name) return;
    setIsSavingTags(true);
    try {
      await api.products.createTag(id, name);
      const saved = await api.products.setTags(id, detail.product.handle, [...detail.product.tags, name]);
      queryClient.setQueryData<ProductFull>(["product", id, detail.product.handle], (current) => current ? { ...current, product: { ...current.product, tags: saved } } : current);
      await Promise.all([queryClient.invalidateQueries({ queryKey: ["products-merged", id] }), queryClient.invalidateQueries({ queryKey: ["product-tags", id] })]);
      setNewTag(""); toast.success("标签已创建并添加。");
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
    try { await api.products.deleteTag(id, deleteTag); await Promise.all([queryClient.invalidateQueries({ queryKey: ["product-tags", id] }), queryClient.invalidateQueries({ queryKey: ["products-merged", id] })]); setDeleteTag(null); toast.success("标签已删除。"); }
    catch (cause) { toast.error(apiErrorMessage(cause, "标签删除失败。")); }
  };

  if (projectQuery.isLoading) return <div className="si-page-loading" role="status">正在加载项目信息…</div>;
  if (projectQuery.isError || !project) return <ApiErrorNotice page label="项目产品管理页面加载失败。" error={projectQuery.error} onRetry={() => void projectQuery.refetch()} />;
  const syncStatus = project.sync.state === "ok"
    ? <Chip tone="ok">{project.sync.at ? `${formatDateTime(project.sync.at)} · 同步成功` : "同步成功 · 时间未知"}</Chip>
    : <Chip tone={project.sync.state === "failed" ? "danger" : "warn"}>{project.sync.state === "failed" ? "同步失败" : project.sync.state === "running" ? "同步中" : "待处理"}</Chip>;

  return <div className="si-page si-products-page">
    <ProjectHeader project={project} activeTab="products" hasTabPanel status={syncStatus}
      actions={<><Button variant="primary" icon={<RefreshCw size={14} />} disabled={Boolean(activeRunId)} onClick={() => void runSync()}>{activeRunId ? "同步中…" : "立即同步"}</Button><Button icon={<TrendingUp size={14} />} onClick={() => setTrendDrawerOpen(true)}>趋势与分类在线率</Button><Button icon={<Download size={14} />} onClick={exportCsv}>导出 CSV</Button></>}
      overflow={[
        { label: "查看今日日报", onSelect: () => void openReport(), icon: <FileText size={14} /> },
        { label: "标签管理", onSelect: () => setTagDialogOpen(true), icon: <Tag size={14} /> },
        { label: "SKU 父子规则预览与设置", onSelect: () => setGroupingDrawerOpen(true), icon: <Settings2 size={14} /> },
      ]}
    />
    <ProjectTabPanel projectId={project.id} tab="products">
      {syncMessage && <Notice tone="info" title="库存同步进行中">{syncMessage}</Notice>}
      {!groupingEnabled && <Notice tone="warn" title="父 SKU 分组尚未启用">当前按 Core 返回的独立 SKU 展示。启用规则后，产品表会显示父 SKU 汇总。<Button size="small" onClick={() => setGroupingDrawerOpen(true)}>查看规则预览</Button></Notice>}
      {summaryQuery.isLoading ? <div className="si-query-loading" role="status">正在加载库存概览…</div> : summaryQuery.isError || !summary ? <ApiErrorNotice label="库存概览加载失败。" error={summaryQuery.error} onRetry={() => void summaryQuery.refetch()} /> : <div className="si-inventory-kpis">{summary.kpis.slice(0, 5).map((metric) => <KpiCard key={metric.key} metric={metric} />)}</div>}
      {productListQuery.isFetching && productListQuery.data && <div className="si-inventory-query-state" role="status">正在更新产品列表…</div>}
      {productListQuery.isError && <ApiErrorNotice className="si-inventory-query-state" label="产品列表更新失败。" error={productListQuery.error} onRetry={() => void productListQuery.refetch()} />}
      {inventoryListQuery.isError && <ApiErrorNotice className="si-inventory-query-state" label="库存指标加载失败。" error={inventoryListQuery.error} onRetry={() => void inventoryListQuery.refetch()} />}
      {productListQuery.isLoading || inventoryListQuery.isLoading ? <div className="si-query-loading" role="status">正在加载产品与库存数据…</div> : <div className="si-products-table-frame">
        <DataTable tableId="products.merged" scopeId={id} rows={tableRows} total={sortedRows.length} columns={columns} query={query} onQueryChange={onTableQueryChange} onRowClick={(row) => { setSelectedRow(row); setDrawerSegment("overview"); }} getRowId={(row) => row.id} height="fill" rowHeight={52} emptyTitle="没有匹配的产品或 SKU" emptyDescription={query.filters?.watched_only ? "关注分类中没有符合当前筛选条件的 SKU。" : "请修改搜索文字或筛选条件。"}
          toolbar={<div className="si-products-toolbar">
            <div className="si-products-toolbar-top"><SearchInput value={query.search ?? ""} onSearch={onSearch} label="搜索产品与 SKU" placeholder="搜索 SKU、产品、变体、分类或标签" /><span className="si-products-result-count">显示 {tableRows.length} / {sortedRows.length} 条</span></div>
            <FilterBar className="si-products-filter-conditions">
              <Select ariaLabel="库存状态筛选" value={query.filters?.status ?? "all"} onValueChange={(value) => onFilter("status", !value || value === "all" ? undefined : value as SkuStockFilters["status"])} options={stockOptions} />
              <Select ariaLabel="分类筛选" value={query.filters?.category ?? "all"} onValueChange={(value) => onFilter("category", !value || value === "all" ? undefined : value)} options={[{ value: "all", label: "全部分类" }, ...categoryOptions.map((value) => ({ value, label: value }))]} />
              <Select ariaLabel="价格变动筛选" value={query.filters?.price_changed_within?.toString() ?? "none"} onValueChange={(value) => onFilter("price_changed_within", value === "none" ? undefined : value === "all" ? "all" : Number(value) as 30 | 60 | 90)} options={priceOptions} />
              <Select ariaLabel="标签筛选" value={query.filters?.tag ?? "all"} onValueChange={(value) => onFilter("tag", !value || value === "all" ? undefined : value)} options={[{ value: "all", label: "全部标签" }, ...(tagsQuery.data ?? []).map((item) => ({ value: item.tag, label: item.tag }))]} />
              <label className="si-inventory-parent-toggle"><input type="checkbox" aria-label="仅关注分类" checked={Boolean(query.filters?.watched_only)} onChange={(event) => onFilter("watched_only", event.target.checked || undefined)} /><span>仅关注分类</span></label>
              <Segmented value={parentOnly ? "parent" : "child"} options={[{ value: "parent", label: "仅父 SKU" }, { value: "child", label: "显示子 SKU" }]} onChange={onViewChange} ariaLabel="SKU 展示模式" />
            </FilterBar>
            {tagsQuery.isError && <ApiErrorNotice label="标签筛选加载失败。" error={tagsQuery.error} onRetry={() => void tagsQuery.refetch()} />}
          </div>}
        />
      </div>}
    </ProjectTabPanel>

    <Drawer open={Boolean(selectedRow)} onOpenChange={(open) => { if (!open) setSelectedRow(null); }} title={selectedRow?.product.title ?? "产品详情"} description={selectedRow?.sku ? `SKU ${selectedRow.sku}` : undefined} width="wide">
      {detailQuery.isLoading ? <div className="si-query-loading" role="status">正在加载产品详情…</div> : detailQuery.isError ? <ApiErrorNotice label="产品详情加载失败。" error={detailQuery.error} onRetry={() => void detailQuery.refetch()} /> : detail && selectedRow ? <>
        <Segmented value={drawerSegment} options={[{ value: "overview", label: "概况" }, { value: "variants", label: "变体库存" }, { value: "history", label: "历史" }]} onChange={(value) => setDrawerSegment(value)} ariaLabel="产品详情分段" />
        {drawerSegment === "overview" && <ProductOverview detail={detail} row={selectedRow} tags={(tagsQuery.data ?? []).map((item) => item.tag)} isSaving={isSavingTags}
          onAddTag={(name) => void updateTags([...detail.product.tags, name])}
          onCreateAndAddTag={(name) => void createAndAddTag(name)}
          onRemoveTag={(name) => void updateTags(detail.product.tags.filter((tagName) => tagName !== name))}
          onOpenUrl={(url) => void openExternal(url)}
        />}
        {drawerSegment === "variants" && <section className="si-product-variant-section"><h4>变体库存 · {drawerVariants.length} 个</h4>
          {detail.variants === undefined ? <Notice tone="warn" title="当前运行环境未提供变体库存">请更新桌面应用后重试。</Notice> : drawerVariants.length ? <ProductVariantInventory variants={drawerVariants} /> : <p className="si-muted">暂无变体库存数据。</p>}
        </section>}
        {drawerSegment === "history" && <HistoryContent row={selectedRow} variants={drawerVariants} selectedSku={selectedHistorySku || drawerVariants[0]?.sku || ""} onSelectedSkuChange={setSelectedHistorySku} loading={detailStockQuery.isLoading} error={detailStockQuery.error} onRetry={() => void detailStockQuery.refetch()} />}
      </> : <div className="si-empty-state">没有找到该产品的详情。</div>}
    </Drawer>

    <Drawer open={tagDialogOpen} onOpenChange={setTagDialogOpen} title="标签管理" description="为产品整理标签。删除标签前会再次确认。" footer={<Button onClick={() => setTagDialogOpen(false)}>完成</Button>}>
      <ProductTagManager tagsQuery={tagsQuery} newTag={newTag} setNewTag={setNewTag} onCreate={() => void createManagedTag()} onDelete={setDeleteTag} />
    </Drawer>
    <ConfirmDialog open={Boolean(deleteTag)} onOpenChange={(open) => { if (!open) setDeleteTag(null); }} title="删除标签？" description={deleteTag ? `将从所有“${deleteTag}”产品中移除该标签。` : "删除标签后无法恢复。"} confirmLabel="删除标签" tone="danger" onConfirm={() => void removeManagedTag()} />
    <Drawer open={groupingDrawerOpen} onOpenChange={setGroupingDrawerOpen} title="SKU 父子规则预览" description="预览由 Core 计算，不代表父 SKU 的库存或在线率。" footer={<div className="si-products-drawer-actions"><Button onClick={() => setGroupingDrawerOpen(false)}>关闭</Button><Button variant="primary" onClick={openGroupingSettings}>前往项目设置</Button></div>}>
      <GroupingPreview projectId={id} rule={groupingRule} enabled={groupingDrawerOpen} />
    </Drawer>
    <Drawer open={trendDrawerOpen} onOpenChange={setTrendDrawerOpen} title="库存趋势与分类在线率" description="趋势使用 Core 返回的真实业务日期；单日数据保留单点，不补造历史。" width="wide">
      {summaryQuery.isLoading ? <div className="si-query-loading" role="status">正在加载库存概览…</div> : summaryQuery.isError || !summary ? <ApiErrorNotice label="库存概览加载失败。" error={summaryQuery.error} onRetry={() => void summaryQuery.refetch()} /> : <div className="si-inventory-overview-grid">
        <TrendChart summary={summary} range={historyRange} onRangeChange={setHistoryRange} selectedCategories={selectedTrendCategories} onSelectedCategoriesChange={(categories) => setTrendSelection({ projectId: id, categories })} />
        <CategoryPanel summary={summary} project={project} watchedCategories={watchedCategories} showDefaultCategories={displayDefaultCategories} onShowDefaultCategories={setShowDefaultCategories} expanded={categoriesExpanded} onToggleExpanded={() => setCategoriesExpanded((value) => !value)} onManage={openCategorySettings} onSelectCategory={(category) => { onFilter("category", category); setTrendDrawerOpen(false); }} />
      </div>}
    </Drawer>
    <Drawer open={reportOpen} onOpenChange={setReportOpen} title="今日日报" description="库存变化与需要关注的 SKU。">
      {reportLoading ? <div className="si-query-loading" role="status">正在读取今日日报…</div> : reportError ? <ApiErrorNotice label="今日日报读取失败。" error={reportError} onRetry={() => void loadReport()} /> : <pre className="si-inventory-report">{report || "暂无今日日报。"}</pre>}
    </Drawer>
  </div>;
}

import "./products/page.css";
import "./products/inventory-widgets.css";
