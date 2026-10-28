import { useEffect, useRef, useState, type ReactNode } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { FeedInspectResult, SeoRule, SiteConfig } from "@siteindex/shared";
import { api, apiErrorMessage } from "../api";
import { ApiErrorNotice, Button, Chip, Tabs } from "../components";
import "./project-settings-config/page.css";

const projectTabs = [
  { value: "overview", label: "概览" }, { value: "inventory", label: "库存" }, { value: "products", label: "产品" },
  { value: "seo", label: "SEO" }, { value: "content", label: "内容" }, { value: "edm", label: "EDM" },
  { value: "design", label: "设计" }, { value: "readme", label: "README" }, { value: "runs", label: "运行" }, { value: "settings", label: "设置" },
] as const;
const settingsTabs = [
  { value: "config", label: "配置" }, { value: "categories", label: "分类" }, { value: "files", label: "本地文件" },
] as const;
const sectionLinks = [
  ["basic", "基本信息"], ["brand", "品牌"], ["source", "数据源"], ["crawl", "抓取"], ["seo", "SEO"], ["edm", "EDM"], ["integrations", "集成与预留数据源"],
] as const;
const tabHref = (id: string, value: string) => value === "settings" ? `/p/${id}/settings/config` : `/p/${id}${value === "overview" ? "" : "/" + value}`;

function TextField({ label, value, onChange, mono = false, placeholder, type = "text" }: {
  label: string; value: string; onChange: (value: string) => void; mono?: boolean; placeholder?: string; type?: string;
}) {
  return <label className="si-config-field"><span>{label}</span><input className={mono ? "si-text-field si-config-mono" : "si-text-field"} type={type} value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} /></label>;
}

function SelectField({ label, value, options, onChange }: {
  label: string; value: string; options: readonly { value: string; label: string }[]; onChange: (value: string) => void;
}) {
  return <label className="si-config-field"><span>{label}</span><select className="si-text-field" value={value} onChange={(event) => onChange(event.target.value)}>{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>;
}

function TextAreaField({ label, value, onChange, mono = false, rows = 3 }: {
  label: string; value: string; onChange: (value: string) => void; mono?: boolean; rows?: number;
}) {
  return <label className="si-config-field"><span>{label}</span><textarea className={mono ? "si-config-textarea si-config-mono" : "si-config-textarea"} rows={rows} value={value} onChange={(event) => onChange(event.target.value)} /></label>;
}

function ConfigCard({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return <section className="si-config-card" id={id}><h2>{title}</h2>{children}</section>;
}

function SettingsNav({ id, value }: { id: string; value: typeof settingsTabs[number]["value"] }) {
  return <nav className="si-config-subtabs" aria-label="设置分区">{settingsTabs.map((tab) => <Link key={tab.value} to={`/p/${id}/settings/${tab.value}`} className={value === tab.value ? "active" : ""} aria-current={value === tab.value ? "page" : undefined}>{tab.label}</Link>)}</nav>;
}

function asLines(values: readonly string[] | undefined): string { return values?.join("\n") ?? ""; }
function fromLines(value: string): string[] { return value.split("\n").map((item) => item.trim()).filter(Boolean); }
function asFeeds(value: SiteConfig["crawl"]["feed_url"]): string { return (Array.isArray(value) ? value : [value]).join("\n"); }

export function ProjectSettingsConfigPage() {
  const { id = "kingsyard" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const projectQuery = useQuery({ queryKey: ["projects", id], queryFn: () => api.projects.get(id) });
  const [draft, setDraft] = useState<SiteConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [jsonOpen, setJsonOpen] = useState(false);
  const [jsonText, setJsonText] = useState("");
  const [jsonError, setJsonError] = useState("");
  const jsonEditorRef = useRef<HTMLTextAreaElement>(null);
  const [overrideText, setOverrideText] = useState("");
  const [feedResult, setFeedResult] = useState<FeedInspectResult | null>(null);
  const [inspectingFeed, setInspectingFeed] = useState(false);

  useEffect(() => {
    if (!projectQuery.data) return;
    setDraft(projectQuery.data.config);
    setOverrideText(JSON.stringify(projectQuery.data.config.crawl.overrides ?? {}, null, 2));
  }, [projectQuery.data]);

  const patch = <K extends keyof SiteConfig>(key: K, value: SiteConfig[K]) => setDraft((current) => current ? { ...current, [key]: value } : current);
  const patchBrand = <K extends keyof SiteConfig["brand"]>(key: K, value: SiteConfig["brand"][K]) => setDraft((current) => current ? { ...current, brand: { ...current.brand, [key]: value } } : current);
  const patchCrawl = <K extends keyof SiteConfig["crawl"]>(key: K, value: SiteConfig["crawl"][K]) => setDraft((current) => current ? { ...current, crawl: { ...current.crawl, [key]: value } } : current);
  const patchSeo = <K extends keyof NonNullable<SiteConfig["seo"]>>(key: K, value: NonNullable<SiteConfig["seo"]>[K]) => setDraft((current) => current ? { ...current, seo: { ...current.seo, [key]: value } } : current);
  const patchEdm = <K extends keyof NonNullable<SiteConfig["edm"]>>(key: K, value: NonNullable<SiteConfig["edm"]>[K]) => setDraft((current) => current ? { ...current, edm: { ...current.edm, [key]: value } } : current);

  const save = async (next: SiteConfig = draft!) => {
    if (!next || saving) return;
    let config: SiteConfig;
    try {
      const overrides: unknown = JSON.parse(overrideText);
      if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) throw new Error("数据修正必须是 JSON 对象");
      config = { ...next, crawl: { ...next.crawl, overrides: overrides as SiteConfig["crawl"]["overrides"] } };
    } catch (error) {
      setFeedback("保存失败：" + (apiErrorMessage(error, "数据修正 JSON 格式无效")));
      return;
    }
    setSaving(true);
    setFeedback("");
    try {
      const saved = await api.projects.updateConfig(id, config);
      setDraft(saved);
      setOverrideText(JSON.stringify(saved.crawl.overrides ?? {}, null, 2));
      await queryClient.invalidateQueries({ queryKey: ["projects", id] });
      setFeedback("已保存配置");
    } catch (error) {
      setFeedback("保存失败：" + (apiErrorMessage(error, "请稍后重试")));
    } finally {
      setSaving(false);
      window.setTimeout(() => setFeedback(""), 2400);
    }
  };

  const inspectFeed = async () => {
    if (!draft || inspectingFeed) return;
    const feedUrls = (Array.isArray(draft.crawl.feed_url) ? draft.crawl.feed_url : [draft.crawl.feed_url]).map((url) => url.trim()).filter(Boolean);
    if (!feedUrls.length) {
      setFeedback("请先填写至少一个 Feed 地址");
      return;
    }
    setInspectingFeed(true);
    setFeedback("");
    try {
      setFeedResult(await api.projects.inspectFeed(feedUrls, { sku_field: draft.crawl.sku_field ?? "id", category_depth: draft.crawl.category_depth ?? 2 }));
      setFeedback("Feed 检测完成");
    } catch (error) {
      setFeedback("Feed 检测失败：" + (apiErrorMessage(error, "请检查地址后重试")));
    } finally {
      setInspectingFeed(false);
    }
  };

  const openJson = () => { setJsonText(JSON.stringify(draft, null, 2)); setJsonError(""); setJsonOpen(true); };
  const applyJson = () => {
    try {
      const value: unknown = JSON.parse(jsonText);
      if (!value || typeof value !== "object" || !("domain" in value) || !("base_url" in value) || !("crawl" in value)) throw new Error("需要包含 domain、base_url 和 crawl 的项目配置");
      setDraft(value as SiteConfig);
      const config = value as SiteConfig;
      setOverrideText(JSON.stringify(config.crawl.overrides ?? {}, null, 2));
      setJsonOpen(false);
      setJsonError("");
    } catch (error) {
      setJsonError(apiErrorMessage(error, "JSON 格式无效"));
    }
  };

  if (projectQuery.isError) return <ApiErrorNotice page label="项目配置加载失败。" error={projectQuery.error} onRetry={() => void projectQuery.refetch()} />;
  if (projectQuery.isLoading || !projectQuery.data || !draft) return <div className="si-page-loading" role="status">正在加载项目配置…</div>;
  const project = projectQuery.data.summary;

  return <DialogPrimitive.Root open={jsonOpen} onOpenChange={(open) => { if (open) openJson(); else setJsonOpen(false); }}>
  <div className="si-page si-project-config-page">
    <header className="si-project-page-heading">
      <div className="si-project-title-line"><h1>{project.name}</h1><code>index/site.json</code></div>
      <div className="si-page-actions"><DialogPrimitive.Trigger asChild><Button type="button">以 JSON 编辑</Button></DialogPrimitive.Trigger><Button variant="primary" disabled={saving} onClick={() => void save()}>{saving ? "保存中…" : "保存配置"}</Button></div>
    </header>
    <Tabs value="settings" options={projectTabs} ariaLabel="项目页面" onChange={(value) => navigate(tabHref(id, value))} />
    <SettingsNav id={id} value="config" />
    {feedback && <p className="si-feedback" role="status">{feedback}</p>}
    <div className="si-config-layout">
      <nav className="si-config-outline" aria-label="配置目录">{sectionLinks.map(([target, label]) => <a key={target} href={"#" + target}>{label}</a>)}</nav>
      <div className="si-config-sections">
        <ConfigCard id="basic" title="基本信息"><div className="si-config-grid si-config-grid-3">
          <TextField label="域名" value={draft.domain} mono onChange={(value) => patch("domain", value)} />
          <TextField label="网站地址" value={draft.base_url} mono onChange={(value) => patch("base_url", value)} />
          <SelectField label="平台" value={draft.platform} options={[{ value: "magento", label: "Magento" }, { value: "wordpress", label: "WordPress / WooCommerce" }, { value: "shopify", label: "Shopify" }, { value: "other", label: "其他" }]} onChange={(value) => patch("platform", value as SiteConfig["platform"])} />
          <TextField label="币种" value={draft.currency} onChange={(value) => patch("currency", value.toUpperCase())} />
          <TextField label="语言" value={draft.locale} onChange={(value) => patch("locale", value)} />
          <TextField label="时区" value={draft.timezone} onChange={(value) => patch("timezone", value)} />
          <TextField label="目标市场（逗号分隔）" value={(draft.markets ?? []).join(", ")} onChange={(value) => patch("markets", value.split(",").map((item) => item.trim()).filter(Boolean))} />
        </div></ConfigCard>

        <ConfigCard id="brand" title="品牌"><div className="si-config-grid si-config-grid-2">
          <TextField label="品牌名" value={draft.brand.name} onChange={(value) => patchBrand("name", value)} />
          <TextField label="一句话定位" value={draft.brand.tagline ?? ""} onChange={(value) => patchBrand("tagline", value)} />
          <TextField label="文案调性" value={draft.brand.voice ?? ""} onChange={(value) => patchBrand("voice", value)} />
          <TextField label="目标人群" value={draft.brand.audience ?? ""} onChange={(value) => patchBrand("audience", value)} />
        </div><TextAreaField label="核心卖点（每行一项）" value={asLines(draft.brand.usp)} onChange={(value) => patchBrand("usp", fromLines(value))} rows={2} /></ConfigCard>

        <ConfigCard id="source" title="数据源 · GMC feed"><div className="si-config-card-title"><p>Feed 地址（按顺序合并）</p><div className="si-config-feed-actions"><Button size="small" disabled={inspectingFeed} onClick={() => void inspectFeed()}>{inspectingFeed ? "检测中…" : "检测 Feed"}</Button><Button size="small" onClick={() => patchCrawl("feed_url", [...(Array.isArray(draft.crawl.feed_url) ? draft.crawl.feed_url : [draft.crawl.feed_url]), ""])}>+ 添加 feed</Button></div></div>
          <TextAreaField label="每行一个地址" value={asFeeds(draft.crawl.feed_url)} onChange={(value) => patchCrawl("feed_url", fromLines(value))} mono rows={3} />
          {feedResult && <div className="si-config-feed-result" role="status"><strong>检测结果</strong><span>{feedResult.items.toLocaleString("zh-CN")} 条目</span><span>{feedResult.usable_skus.toLocaleString("zh-CN")} 个可用 SKU</span><span>{feedResult.products.toLocaleString("zh-CN")} 个产品</span><span>跳过：重复 {feedResult.skipped.duplicate} · 缺价格或链接 {feedResult.skipped.missing_price_or_link} · 缺 ID {feedResult.skipped.no_id}</span></div>}
          <div className="si-config-grid si-config-grid-3">
            <TextField label="SKU 字段" value={draft.crawl.sku_field ?? "id"} onChange={(value) => patchCrawl("sku_field", value)} />
            <TextField label="主分类层级" type="number" value={String(draft.crawl.category_depth ?? 2)} onChange={(value) => patchCrawl("category_depth", value === "" ? undefined : Number(value))} />
            <SelectField label="商品消失时" value={draft.crawl.missing_as ?? "out_of_stock"} options={[{ value: "out_of_stock", label: "先记缺货" }, { value: "removed", label: "立即判定下架" }]} onChange={(value) => patchCrawl("missing_as", value as SiteConfig["crawl"]["missing_as"])} />
            <TextField label="移除保护阈值（0–1）" type="number" value={String(draft.crawl.max_removed_ratio ?? 0.1)} onChange={(value) => patchCrawl("max_removed_ratio", value === "" ? undefined : Number(value))} />
            <TextField label="Feed 生成时间" value={draft.crawl.feed_generated_at ?? ""} placeholder="每天 01:00" onChange={(value) => patchCrawl("feed_generated_at", value)} />
            <TextField label="站点地图（每行一个）" value={asLines(draft.sitemaps)} mono onChange={(value) => patch("sitemaps", fromLines(value))} />
          </div>
          <div className="si-config-callout"><span><strong>分类识别：{draft.categories.mode === "manual" ? "手动配置" : draft.categories.mode === "feed" ? "Feed 分类字段" : "URL 规则"}</strong><small>分类规则、候选分类页与预览结果在分类设置中管理。</small></span><Link to={`/p/${id}/settings/categories`} className="si-config-inline-link">分类设置</Link></div>
          <TextAreaField label="数据修正（overrides，JSON 对象）" value={overrideText} onChange={setOverrideText} mono rows={3} />
        </ConfigCard>

        <ConfigCard id="crawl" title="抓取"><div className="si-config-grid si-config-grid-3">
          <TextField label="请求间隔（毫秒）" type="number" value={String(draft.crawl.rate_limit_ms)} onChange={(value) => patchCrawl("rate_limit_ms", Number(value) || 0)} />
          <TextField label="每周最多页面" type="number" value={String(draft.crawl.max_pages ?? 2000)} onChange={(value) => patchCrawl("max_pages", value === "" ? undefined : Number(value))} />
          <label className="si-config-check"><input type="checkbox" checked={draft.crawl.crawl_product_pages ?? true} onChange={(event) => patchCrawl("crawl_product_pages", event.target.checked)} /><span>每周抓取产品页 SEO</span></label>
        </div><div className="si-config-grid si-config-grid-2">
          <TextAreaField label="博客 URL 规则（每行一条）" value={asLines(draft.crawl.blog_url_patterns)} onChange={(value) => patchCrawl("blog_url_patterns", fromLines(value))} mono rows={2} />
          <TextAreaField label="排除 URL 规则（每行一条）" value={asLines(draft.crawl.exclude_url_patterns)} onChange={(value) => patchCrawl("exclude_url_patterns", fromLines(value))} mono rows={2} />
        </div></ConfigCard>

        <ConfigCard id="seo" title="SEO"><div className="si-config-grid si-config-grid-2">
          <TextAreaField label="核心关键词（每行一项）" value={asLines(draft.seo?.core_keywords)} onChange={(value) => patchSeo("core_keywords", fromLines(value))} rows={3} />
          <TextAreaField label="竞品域名（每行一个）" value={asLines(draft.seo?.competitors)} onChange={(value) => patchSeo("competitors", fromLines(value))} mono rows={3} />
          <div className="si-config-range"><span>Title 长度范围</span><div><input aria-label="Title 最短长度" className="si-text-field" type="number" value={draft.seo?.title_range?.[0] ?? 30} onChange={(event) => patchSeo("title_range", [Number(event.target.value), draft.seo?.title_range?.[1] ?? 60])} /><span>至</span><input aria-label="Title 最长长度" className="si-text-field" type="number" value={draft.seo?.title_range?.[1] ?? 60} onChange={(event) => patchSeo("title_range", [draft.seo?.title_range?.[0] ?? 30, Number(event.target.value)])} /></div></div>
          <div className="si-config-range"><span>Description 长度范围</span><div><input aria-label="Description 最短长度" className="si-text-field" type="number" value={draft.seo?.description_range?.[0] ?? 70} onChange={(event) => patchSeo("description_range", [Number(event.target.value), draft.seo?.description_range?.[1] ?? 155])} /><span>至</span><input aria-label="Description 最长长度" className="si-text-field" type="number" value={draft.seo?.description_range?.[1] ?? 155} onChange={(event) => patchSeo("description_range", [draft.seo?.description_range?.[0] ?? 70, Number(event.target.value)])} /></div></div>
          <TextAreaField label="忽略的检查规则（每行 URL | 规则）" value={(draft.seo?.ignore_rules ?? []).map((item) => item.url + " | " + item.rule).join("\n")} onChange={(value) => {
            const rules = value.split("\n").map((line) => line.split("|").map((part) => part.trim())).filter((parts) => parts[0] && parts[1]);
            patchSeo("ignore_rules", rules.map(([url, rule]) => ({ url: url!, rule: rule! as SeoRule })));
          }} mono rows={2} />
        </div></ConfigCard>

        <ConfigCard id="edm" title="EDM"><div className="si-config-grid si-config-grid-3">
          <SelectField label="邮件平台" value={draft.edm?.platform ?? "mailchimp"} options={[{ value: "mailchimp", label: "Mailchimp" }, { value: "wordpress", label: "WordPress 邮件插件" }, { value: "other", label: "其他" }]} onChange={(value) => patchEdm("platform", value as NonNullable<SiteConfig["edm"]>["platform"])} />
          <TextField label="每封产品数" type="number" value={String(draft.edm?.max_products ?? 6)} onChange={(value) => patchEdm("max_products", Number(value) || 0)} />
          <TextField label="推荐冷却期（天）" type="number" value={String(draft.edm?.cooldown_days ?? 21)} onChange={(value) => patchEdm("cooldown_days", Number(value) || 0)} />
          <TextField label="UTM source" value={draft.edm?.utm?.source ?? ""} onChange={(value) => patchEdm("utm", { ...draft.edm?.utm, source: value })} />
          <TextField label="UTM medium" value={draft.edm?.utm?.medium ?? ""} onChange={(value) => patchEdm("utm", { ...draft.edm?.utm, medium: value })} />
          <SelectField label="图片优先级" value={(draft.edm?.image_priority ?? ["feed", "manual"]).join(",")} options={[{ value: "feed,manual", label: "抓取首图 → 手动首图" }, { value: "manual,feed", label: "手动首图 → 抓取首图" }]} onChange={(value) => patchEdm("image_priority", value.split(",") as NonNullable<SiteConfig["edm"]>["image_priority"])} />
        </div><TextField label="默认受众" value={String(draft.integrations?.mailchimp?.audience ?? "")} placeholder="Mailchimp audience / segment" onChange={(value) => patch("integrations", { ...draft.integrations, mailchimp: { ...draft.integrations?.mailchimp, audience: value } })} /></ConfigCard>

        <ConfigCard id="integrations" title="集成与预留数据源"><div className="si-config-grid si-config-grid-2">
          <TextField label="LinkFlow MCP 服务" value={draft.integrations?.linkflow?.mcp_server ?? ""} onChange={(value) => patch("integrations", { ...draft.integrations, linkflow: { ...draft.integrations?.linkflow, mcp_server: value } })} mono />
          <TextField label="录入工具" value={draft.integrations?.linkflow?.create_tool ?? ""} onChange={(value) => patch("integrations", { ...draft.integrations, linkflow: { ...draft.integrations?.linkflow, create_tool: value } })} mono />
        </div><div className="si-config-reserved-grid">{[
          ["销量数据", "Magento API / WordPress REST / MCP → index/sales/"], ["Google Search Console", "收录、展现、点击、排名 → index/seo/"], ["Mailchimp 报告", "收件、打开、点击、收入 → edm_campaigns"],
        ].map(([title, detail]) => <div className="si-config-reserved" key={title}><strong>{title}</strong><span>{detail}</span><Chip tone="neutral">预留 · 未连接</Chip></div>)}</div></ConfigCard>
      </div>
    </div>
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="si-config-json-overlay" />
      <DialogPrimitive.Content className="si-config-json-dialog" onOpenAutoFocus={(event) => { event.preventDefault(); jsonEditorRef.current?.focus(); }}>
        <div className="si-panel-heading"><DialogPrimitive.Title className="si-dialog-title">编辑项目 JSON</DialogPrimitive.Title><DialogPrimitive.Close asChild><Button size="small" type="button" aria-label="关闭 JSON 编辑器">关闭</Button></DialogPrimitive.Close></div>
        <DialogPrimitive.Description className="si-config-json-description">修改完整配置后应用；保存配置时才会写入项目文件。</DialogPrimitive.Description>
        <textarea ref={jsonEditorRef} className="si-config-json-editor" aria-label="项目 JSON" value={jsonText} onChange={(event) => setJsonText(event.target.value)} spellCheck={false} />
        {jsonError && <p className="si-form-error" role="alert">{jsonError}</p>}
        <div className="si-config-json-actions"><DialogPrimitive.Close asChild><Button type="button">取消</Button></DialogPrimitive.Close><Button variant="primary" onClick={applyJson}>应用 JSON</Button></div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  </div>
  </DialogPrimitive.Root>;
}
