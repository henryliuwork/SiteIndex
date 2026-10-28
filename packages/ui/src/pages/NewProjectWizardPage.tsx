import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CircleAlert, FolderOpen, LoaderCircle, Plus, X } from "lucide-react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { INIT_STEPS, type DetectResult, type FeedInspectResult, type InitStepKey, type JobProgress, type JobResult, type Platform } from "@siteindex/shared";
import { api, apiErrorMessage } from "../api";
import { Button, Chip } from "../components";
import { useWizardDraft } from "./wizard-state";

const steps = [
  { path: "/new/url", label: "网址" },
  { path: "/new/source", label: "数据源" },
  { path: "/new/brand", label: "品牌配置" },
  { path: "/new/done", label: "完成" },
];
const platformNames: Record<Platform, string> = { magento: "Magento", wordpress: "WordPress", woocommerce: "WooCommerce", shopify: "Shopify", other: "其他平台" };
const progressSteps: Record<InitStepKey, { name: string; detail: string }> = {
  folders: { name: "创建数据目录", detail: "index/ 网站数据索引" },
  config: { name: "写入配置", detail: "index/site.json" },
  readme: { name: "生成 README", detail: "README.md、AGENTS.md、CLAUDE.md" },
  skills: { name: "分发 skill", detail: "_agent/skills/" },
  daily: { name: "首次每日同步", detail: "Feed → SKU 与库存基线" },
  weekly: { name: "首次每周同步", detail: "Sitemap → 页面与 SEO 数据" },
  views: { name: "生成视图并校验", detail: "检查生成的数据文件" },
  schedule: { name: "注册定时任务", detail: "为项目启用计划任务" },
};

type StepStatus = "waiting" | "running" | "ok" | "failed";
type StepState = { status: StepStatus; reason?: string };
type StepStates = Partial<Record<InitStepKey, StepState>>;
type RetryableStep = Extract<InitStepKey, "daily" | "weekly" | "views" | "schedule">;

function initStepKey(value?: string): InitStepKey | undefined {
  return INIT_STEPS.find((key) => key === value);
}

function isRetryableStep(key: InitStepKey): key is RetryableStep {
  return key === "daily" || key === "weekly" || key === "views" || key === "schedule";
}

function applyInitProgress(current: StepStates, event: JobProgress): StepStates {
  const key = initStepKey(event.step);
  if (!key) return current;
  const next = { ...current };
  for (const previous of INIT_STEPS) {
    if (previous === key) break;
    if (next[previous]?.status === "running") next[previous] = { status: "ok" };
  }
  next[key] = event.level === "error" ? { status: "failed", reason: event.message } : { status: "running" };
  return next;
}

function applyInitResult(current: StepStates, result: JobResult): StepStates {
  const next = { ...current };
  for (const step of result.steps ?? []) {
    const key = initStepKey(step.key);
    if (!key) continue;
    next[key] = step.status === "ok" ? { status: "ok" }
      : step.status === "failed" ? { status: "failed", reason: step.message || result.errors?.join("；") || result.summary }
        : { status: "waiting", reason: step.message || "本次已跳过" };
  }
  for (const key of INIT_STEPS) {
    if (next[key]?.status === "running") next[key] = result.status === "ok" ? { status: "ok" } : { status: "waiting", reason: "未返回步骤结果" };
  }
  return next;
}

function slugFor(url: string): string {
  try { return new URL(/^https?:\/\//i.test(url) ? url : "https://" + url).hostname.replace(/^www\./, "").split(".")[0]?.toLowerCase().replace(/[^a-z0-9-]+/g, "-") ?? "new-project"; }
  catch { return "new-project"; }
}

function pathJoin(root: string, folder: string): string {
  const cleanRoot = root.replace(/[\\/]+$/, "");
  return cleanRoot + (root.includes("\\") ? "\\" : "/") + folder;
}

function pathFromCreateResponse(value: unknown): string | null {
  if (typeof value !== "object" || value === null || !("path" in value)) return null;
  const path = value.path;
  return typeof path === "string" && path.trim() ? path : null;
}

async function readCreatedProjectPath(id: string): Promise<string | null> {
  const project = await api.projects.get(id);
  const path = project.summary.path;
  return typeof path === "string" && path.trim() ? path : null;
}

function WizardSteps({ active }: { active: number }) {
  return <ol className="si-wizard-steps" aria-label="新建项目步骤">{steps.map((step, index) => <li key={step.path} className={index === active ? "active" : index < active ? "complete" : ""}>
    {index < active ? <Link to={step.path}><Check size={13} aria-hidden="true" />{index + 1} {step.label}</Link> : <span>{index + 1} {step.label}</span>}
  </li>)}</ol>;
}

function ResultLine({ label, children, tone = "ok", status }: { label: string; children: ReactNode; tone?: "ok" | "warn"; status?: string }) {
  return <div className="si-wizard-result-line"><Check size={16} aria-hidden="true" /><strong>{label}</strong><span>{children}</span><Chip tone={tone}>{status ?? (tone === "ok" ? "已识别" : "待填写")}</Chip></div>;
}

function DetectSummary({ result }: { result: DetectResult }) {
  const sitemapText = result.sitemaps.map((item) => (item.type === "index" ? "索引" : "URL 集") + " · " + item.url_count + " 个 URL").join("；") || "未发现 sitemap";
  return <div className="si-wizard-detect-list">
    <ResultLine label="跳转" status={result.redirect_status ? String(result.redirect_status) : "无跳转"}>{result.redirect_status ? result.input + " → " + result.final_url : result.final_url}</ResultLine>
    <ResultLine label="robots.txt" status={result.robots.found ? "200" : "未找到"}>{result.robots.found ? result.robots.disallow_count + " 条 Disallow，声明 " + result.robots.sitemaps.length + " 个 sitemap" : "未找到 robots.txt"}</ResultLine>
    <ResultLine label="Sitemap" status={result.sitemaps.length ? "已展开" : "未发现"}>{sitemapText}</ResultLine>
    <ResultLine label="平台">{platformNames[result.platform]}（{result.platform_evidence}）{result.frontend ? " · 前台 " + result.frontend : ""}</ResultLine>
    <ResultLine label="语言 / 币种">{result.locale ?? "未识别语言"} / {result.currency ?? "未识别币种"}</ResultLine>
    <ResultLine label="GMC feed" tone={result.feed_candidates.length ? "ok" : "warn"} status={result.feed_candidates.length ? "已识别" : "待填写"}>{result.feed_candidates.length ? "发现 " + result.feed_candidates.length + " 个候选地址" : "网站上未发现公开的 feed 地址，下一步手动填写"}</ResultLine>
  </div>;
}

function FeedStats({ result }: { result: FeedInspectResult }) {
  const skipped = result.skipped.duplicate + result.skipped.missing_price_or_link + result.skipped.no_id;
  const stats = [
    { label: "feed 条目", value: result.items, hint: "" },
    { label: "可用 SKU", value: result.usable_skus, hint: "" },
    { label: "产品（归组后）", value: result.products, hint: "" },
    { label: "已跳过", value: skipped, hint: "重复 id " + result.skipped.duplicate + " · 缺价格或链接 " + result.skipped.missing_price_or_link },
  ];
  return <div className="si-wizard-stats">{stats.map((stat) => <div key={stat.label}><span>{stat.label}</span><strong>{stat.value}</strong>{stat.hint && <small>{stat.hint}</small>}</div>)}</div>;
}

function FeedInspection({ result, settings }: { result: FeedInspectResult; settings: ReactNode }) {
  return <>
    <div className="si-wizard-inspect-grid">
      <section className="si-wizard-subpanel"><h2>字段覆盖率</h2>{result.field_coverage.map((field) => <div className="si-wizard-coverage" key={field.field}><code>{field.field}</code><span><i style={{ width: field.pct + "%" }} /></span><small>{field.pct}%</small></div>)}</section>
      {settings}
    </div>
    <div className="si-wizard-samples"><h2>示例数据（前 4 条）</h2><div className="si-wizard-table-scroll"><table><thead><tr><th>SKU</th><th>产品</th><th>变体</th><th>分类</th><th>价格</th><th>库存</th></tr></thead><tbody>{result.samples.slice(0, 4).map((row) => <tr key={row.sku}><td><code>{row.sku}</code></td><td>{row.title}</td><td>{row.variant_title || "—"}</td><td><code>{row.category || "—"}</code></td><td>{row.price}</td><td><Chip tone={row.stock_status === "in_stock" ? "ok" : row.stock_status === "out_of_stock" ? "danger" : row.stock_status === "preorder" ? "warn" : "neutral"}>{row.stock_status === "in_stock" ? "有货" : row.stock_status === "out_of_stock" ? "缺货" : row.stock_status === "preorder" ? "预售" : "未知"}</Chip></td></tr>)}</tbody></table></div></div>
  </>;
}

export function NewProjectWizardPage() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { draft, update, reset } = useWizardDraft();
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api.settings.get() });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [feedError, setFeedError] = useState("");
  const [canRetryFeed, setCanRetryFeed] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [uspDraft, setUspDraft] = useState("");
  const [stepStates, setStepStates] = useState<StepStates>({});
  const [retryStates, setRetryStates] = useState<StepStates>({});
  const [finished, setFinished] = useState<JobResult | null>(null);
  const retryRunIds = useRef(new Map<string, RetryableStep>());
  const active = Math.max(0, steps.findIndex((step) => pathname.endsWith(step.path)));
  const createdRunId = draft.created?.runId;

  useEffect(() => { setError(""); setFeedError(""); setCanRetryFeed(false); setFeedback(""); }, [pathname]);
  useEffect(() => {
    if (settings.data?.projects_root && !draft.projectsRoot) update({ projectsRoot: settings.data.projects_root });
  }, [settings.data, draft.projectsRoot, update]);
  useEffect(() => {
    if (active > 0 && active < 3 && !draft.detect) navigate("/new/url", { replace: true });
  }, [active, draft.detect, navigate]);
  useEffect(() => {
    if (active === 0 && draft.created) reset();
  }, [active, draft.created, reset]);
  useEffect(() => {
    setStepStates({}); setRetryStates({}); setFinished(null); retryRunIds.current.clear();
  }, [createdRunId]);
  useEffect(() => {
    if (active !== 3 || !createdRunId) return;
    const onProgress = api.jobs.onProgress((event) => {
      if (event.runId === createdRunId && event.job === "init") setStepStates((current) => applyInitProgress(current, event));
    });
    const onFinished = api.jobs.onFinished((result) => {
      if (result.runId === createdRunId) {
        setFinished(result);
        setStepStates((current) => applyInitResult(current, result));
      }
      const retryKey = retryRunIds.current.get(result.runId);
      if (retryKey) {
        retryRunIds.current.delete(result.runId);
        setRetryStates((current) => ({ ...current, [retryKey]: result.status === "ok"
          ? { status: "ok" }
          : { status: "failed", reason: result.errors?.join("；") || result.summary || "重试失败" } }));
      }
    });
    return () => { onProgress(); onFinished(); };
  }, [active, createdRunId]);

  const detectSite = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(""); setFeedback("");
    try {
      const result = await api.projects.detect(draft.url.trim());
      const brandName = draft.brand.name || slugFor(draft.url).replace(/(^|-)([a-z])/g, (_match, _dash, letter: string) => letter.toUpperCase());
      update({ detect: result, feedUrls: result.feed_candidates, feedResult: null, folderName: draft.folderName || slugFor(draft.url), brand: { ...draft.brand, name: brandName } });
    } catch (cause) { setError(apiErrorMessage(cause, "网站检测失败，请重试。")); }
    finally { setBusy(false); }
  };

  const inspectFeed = async () => {
    const feedUrls = draft.feedUrls.map((url) => url.trim()).filter(Boolean);
    if (!feedUrls.length) { setFeedError("请输入至少一个 GMC feed 地址。"); setCanRetryFeed(false); return false; }
    setBusy(true); setError(""); setFeedError(""); setCanRetryFeed(false);
    try {
      const result = await api.projects.inspectFeed(feedUrls, { sku_field: draft.skuField, category_depth: draft.categoryDepth });
      update({ feedUrls, feedResult: result }); return true;
    } catch (cause) { setFeedError(apiErrorMessage(cause, "Feed 检测失败，请检查地址后重试。")); setCanRetryFeed(true); return false; }
    finally { setBusy(false); }
  };

  const createProject = async () => {
    const root = draft.projectsRoot || settings.data?.projects_root || "";
    if (!draft.feedResult) { setError("请先返回数据源步骤并检测 Feed。"); return; }
    if (!draft.brand.name.trim() || !draft.folderName.trim() || !root.trim()) { setError("请填写品牌名、项目文件夹名和项目根目录。"); return; }
    setBusy(true); setError("");
    try {
      const created = await api.projects.create({
        url: draft.detect?.final_url ?? draft.url,
        feed_urls: draft.feedUrls,
        sku_field: draft.skuField,
        category_depth: draft.categoryDepth,
        missing_as: draft.missingAs,
        brand: { ...draft.brand, name: draft.brand.name.trim() },
        markets: draft.market.split(/[，,]/).map((item) => item.trim()).filter(Boolean),
        projects_root: root.trim(),
        folder_name: draft.folderName.trim(),
        workspace_folders: [],
      });
      let actualPath = pathFromCreateResponse(created);
      if (!actualPath) {
        try { actualPath = await readCreatedProjectPath(created.id); }
        catch { actualPath = null; }
      }
      update({ projectsRoot: root, created: { ...created, path: actualPath } });
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      navigate("/new/done");
    } catch (cause) { setError(apiErrorMessage(cause, "创建项目失败，请重试。")); }
    finally { setBusy(false); }
  };

  const openFolder = async () => {
    const path = draft.created?.path;
    if (!path) { setError("尚未读取到项目的实际路径，请先重试读取路径。"); return; }
    try { await api.shell.openPath(path); setFeedback("已打开项目文件夹。"); }
    catch (cause) { setError(apiErrorMessage(cause, "打开文件夹失败。")); }
  };

  const retryReadCreatedPath = async () => {
    if (!draft.created) return;
    setBusy(true); setError(""); setFeedback("");
    try {
      const path = await readCreatedProjectPath(draft.created.id);
      if (!path) { setError("项目详情没有返回实际路径，请稍后重试。"); return; }
      update({ created: { ...draft.created, path } });
      setFeedback("已读取项目实际路径。");
    } catch (cause) { setError(apiErrorMessage(cause, "读取项目实际路径失败，请重试。")); }
    finally { setBusy(false); }
  };

  const retryStep = async (key: RetryableStep) => {
    if (!draft.created) return;
    const projectId = draft.created.id;
    setRetryStates((current) => ({ ...current, [key]: { status: "running" } }));
    try {
      if (key === "schedule") {
        const schedule = await api.schedule.get(projectId);
        await api.schedule.save(projectId, schedule.config);
        setRetryStates((current) => ({ ...current, schedule: { status: "ok" } }));
      } else {
        const project = await api.projects.get(projectId);
        const run = await api.jobs.run({ projectPath: project.summary.path, job: key });
        retryRunIds.current.set(run.runId, key);
      }
    } catch (cause) {
      setRetryStates((current) => ({ ...current, [key]: { status: "failed", reason: apiErrorMessage(cause, "重试失败，请稍后再试。") } }));
    }
  };

  if (active === 3 && !draft.created) return <Navigate to="/new/brand" replace />;
  const detection = draft.detect;
  const previewPath = pathJoin(draft.projectsRoot || settings.data?.projects_root || "D:/SiteIndex/projects", draft.folderName || "[文件夹名]");
  const stateFor = (key: InitStepKey): StepState => retryStates[key] ?? stepStates[key] ?? { status: "waiting" };
  const completedCount = INIT_STEPS.filter((key) => stateFor(key).status === "ok").length;
  const allSucceeded = Boolean(finished) && completedCount === INIT_STEPS.length;
  const hasFinishedFailures = Boolean(finished) && !allSucceeded;
  const progressWidth = Math.round(completedCount / INIT_STEPS.length * 100);
  const stepReasons = INIT_STEPS.map((key) => stateFor(key).reason).filter(Boolean);
  const remainingErrors = finished?.errors?.filter((message) => !stepReasons.includes(message)) ?? [];
  const globalFailure = hasFinishedFailures && (remainingErrors.length > 0 || stepReasons.length === 0)
    ? remainingErrors.join("；") || finished?.summary || "未收到全部步骤的完成结果。"
    : "";

  return <div className="si-page si-wizard-page">
    <div className="si-wizard-breadcrumb"><Link to="/">项目中心</Link><span>/</span><strong>新建项目</strong></div>
    <WizardSteps active={active} />

    {active === 0 && <section className="si-wizard-card si-wizard-url-card">
      <header><h1>输入网站地址</h1><p>SiteIndex 会自动检测跳转、robots.txt、sitemap、建站平台、语言和币种。</p></header>
      <form className="si-wizard-url-form" onSubmit={(event) => void detectSite(event)}>
        <label className="si-sr-only" htmlFor="site-url">网站地址</label>
        <input id="site-url" className="si-text-field si-mono" value={draft.url} onChange={(event) => update({ url: event.target.value, detect: null, feedResult: null })} placeholder="https://example.com" />
        <Button type="submit" variant="primary" disabled={busy}>{busy ? "正在检测…" : "检测"}</Button>
      </form>
      {detection ? <DetectSummary result={detection} /> : <div className="si-wizard-empty"><CircleAlert size={18} />输入网址后检测站点信息。</div>}
      {error && <p className="si-form-error" role="alert">{error}</p>}{feedback && <p className="si-feedback" role="status">{feedback}</p>}
      <footer className="si-wizard-actions"><Button onClick={() => { reset(); navigate("/"); }}>取消</Button><Button variant="primary" disabled={!detection} onClick={() => navigate("/new/source")}>下一步：数据源</Button></footer>
    </section>}

    {active === 1 && detection && <div className="si-wizard-source-layout">
      <section className="si-wizard-card si-wizard-site-summary"><h2>网址检测结果</h2><dl>
        <div><dt>最终地址</dt><dd className="si-mono">{detection.final_url}</dd></div>
        <div><dt>平台</dt><dd>{platformNames[detection.platform]}{detection.frontend ? "（前台 " + detection.frontend + "）" : ""}</dd></div>
        <div><dt>robots.txt</dt><dd>{detection.robots.found ? "已读取 · " + detection.robots.disallow_count + " 条 Disallow" : "未找到"}</dd></div>
        <div><dt>Sitemap</dt><dd>{detection.sitemaps.length} 个 sitemap · {detection.total_urls.toLocaleString("zh-CN")} 个 URL</dd></div>
        <div><dt>语言 / 币种</dt><dd>{detection.locale ?? "—"} / {detection.currency ?? "—"}</dd></div>
      </dl><p>GMC feed 可能不在网站上公开，请从 Merchant Center 或 Feed 插件中复制地址。</p></section>
      <div className="si-wizard-source-main">
        <section className="si-wizard-card">
          <div className="si-wizard-field"><div className="si-wizard-feed-heading"><label>GMC 商品 Feed 地址</label>{!draft.feedUrls.length && <Button size="small" onClick={() => update({ feedUrls: [""], feedResult: null })}><Plus size={14} />添加 Feed</Button>}</div>{draft.feedUrls.map((url, index) => <div className="si-wizard-feed-input" key={index}><input className="si-text-field si-mono" value={url} onChange={(event) => { setFeedError(""); setCanRetryFeed(false); update({ feedUrls: draft.feedUrls.map((item, itemIndex) => itemIndex === index ? event.target.value : item), feedResult: null }); }} placeholder="https://example.com/feed.xml" aria-label={"Feed 地址 " + (index + 1)} />{draft.feedUrls.length > 1 && <Button aria-label="移除此 Feed" onClick={() => { setFeedError(""); setCanRetryFeed(false); update({ feedUrls: draft.feedUrls.filter((_, itemIndex) => itemIndex !== index), feedResult: null }); }}><X size={14} /></Button>}{index === 0 && <><Button variant="primary" disabled={busy || !url.trim()} onClick={() => void inspectFeed()}>{busy ? "正在检测…" : draft.feedResult ? "重新检测" : "检测 Feed"}</Button><Button size="small" aria-label="添加 Feed" title="添加 Feed" onClick={() => update({ feedUrls: [...draft.feedUrls, ""], feedResult: null })}><Plus size={14} /></Button></>}</div>)}
            {feedError && <div className="si-wizard-feed-error" role="alert"><span>{feedError}</span>{canRetryFeed && <Button size="small" disabled={busy} onClick={() => void inspectFeed()}>{busy ? "正在重试…" : "重试"}</Button>}</div>}
            <div className="si-wizard-feed-actions"><span>可添加多个 Feed，按顺序合并；同一 ID 以先出现的为准。</span></div>
            {draft.feedResult && <FeedStats result={draft.feedResult} />}
          </div>
          {error && <p className="si-form-error" role="alert">{error}</p>}{feedback && <p className="si-feedback" role="status">{feedback}</p>}
        </section>
        {draft.feedResult && <FeedInspection result={draft.feedResult} settings={<section className="si-wizard-subpanel"><h2>解析设置</h2><div className="si-wizard-config-grid">
            <label className="si-wizard-field">SKU 字段<input className="si-text-field" value={draft.skuField} onChange={(event) => update({ skuField: event.target.value, feedResult: null })} /></label>
            <label className="si-wizard-field">主分类层级<select className="si-text-field" value={draft.categoryDepth} onChange={(event) => update({ categoryDepth: Number(event.target.value), feedResult: null })}><option value={1}>第 1 层</option><option value={2}>第 2 层</option><option value={3}>第 3 层</option></select></label>
          </div><div className="si-wizard-field"><span>商品从 Feed 消失时</span><label className="si-radio-row"><input type="radio" checked={draft.missingAs === "out_of_stock"} onChange={() => update({ missingAs: "out_of_stock" })} />先记为缺货，连续 30 天未出现再判定下架</label><label className="si-radio-row"><input type="radio" checked={draft.missingAs === "removed"} onChange={() => update({ missingAs: "removed" })} />立即判定下架</label></div>
            <div className="si-wizard-category-chips">{draft.feedResult.category_distribution.slice(0, 4).map((category) => <Chip key={category.slug}>{category.slug} · {category.count}</Chip>)}</div>
          </section>} />}
        <footer className="si-wizard-actions"><Button onClick={() => navigate("/new/url")}>上一步</Button><Button variant="primary" disabled={!draft.feedResult} onClick={() => navigate("/new/brand")}>下一步：品牌配置</Button></footer>
      </div>
    </div>}

    {active === 2 && detection && <>
      <div className="si-wizard-brand-layout">
        <section className="si-wizard-card">
          <header className="si-wizard-card-heading"><h2>品牌信息</h2><Chip tone="info">根据网址预填，可修改</Chip></header>
          <div className="si-wizard-form-grid">
            <label className="si-wizard-field">品牌名<input className="si-text-field" value={draft.brand.name} onChange={(event) => update({ brand: { ...draft.brand, name: event.target.value } })} /></label>
            <label className="si-wizard-field">目标市场<input className="si-text-field" value={draft.market} onChange={(event) => update({ market: event.target.value })} placeholder="US, CA" /></label>
            <label className="si-wizard-field full">一句话定位<input className="si-text-field" value={draft.brand.tagline ?? ""} onChange={(event) => update({ brand: { ...draft.brand, tagline: event.target.value } })} /></label>
            <label className="si-wizard-field">目标人群<input className="si-text-field" value={draft.brand.audience ?? ""} onChange={(event) => update({ brand: { ...draft.brand, audience: event.target.value } })} /></label>
            <label className="si-wizard-field">文案调性<input className="si-text-field" value={draft.brand.voice ?? ""} onChange={(event) => update({ brand: { ...draft.brand, voice: event.target.value } })} /></label>
          </div>
          <div className="si-wizard-field si-wizard-usp"><span>核心卖点</span><div className="si-wizard-usp-list">{draft.brand.usp?.map((item) => <Chip key={item}>{item}<button type="button" aria-label={"删除卖点 " + item} onClick={() => update({ brand: { ...draft.brand, usp: draft.brand.usp?.filter((value) => value !== item) } })}>×</button></Chip>)}
            <input value={uspDraft} onChange={(event) => setUspDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); if (uspDraft.trim()) update({ brand: { ...draft.brand, usp: [...(draft.brand.usp ?? []), uspDraft.trim()] } }); setUspDraft(""); } }} placeholder="输入后按 Enter 添加" aria-label="添加核心卖点" />
          </div></div>
          <p className="si-wizard-note">这些信息会写入 index/site.json 与 README「项目概况」，Agent 写文案时会读取。也可以之后在项目设置里补充。</p>
        </section>
        <section className="si-wizard-card si-wizard-location-card">
          <h2>项目位置</h2>
          <label className="si-wizard-field">项目根目录<div className="si-wizard-directory"><input className="si-text-field si-mono" value={draft.projectsRoot || settings.data?.projects_root || ""} onChange={(event) => update({ projectsRoot: event.target.value })} /><Button onClick={async () => { const selected = await api.settings.chooseDirectory(draft.projectsRoot || settings.data?.projects_root); if (selected) update({ projectsRoot: selected }); }}>更改</Button></div><small>默认取自软件设置</small></label>
          <label className="si-wizard-field">项目文件夹名<input className="si-text-field si-mono" value={draft.folderName} onChange={(event) => update({ folderName: event.target.value })} /></label>
          <div className="si-wizard-path"><span>将创建</span><code>{previewPath}</code></div>
        </section>
      </div>
      {error && <p className="si-form-error" role="alert">{error}</p>}
      <footer className="si-wizard-actions"><Button onClick={() => navigate("/new/source")}>上一步</Button><Button variant="primary" onClick={() => void createProject()} disabled={busy}>{busy ? "正在创建…" : "创建项目"}</Button></footer>
    </>}

    {active === 3 && draft.created && <div className="si-wizard-done-layout">
      {draft.created.path ? null : <p className="si-form-error" role="alert">项目已创建，但暂时无法读取实际路径。请重试读取，路径读取成功后即可打开文件夹。</p>}
      <section className="si-wizard-card si-wizard-progress-card">
        <header className="si-wizard-progress-heading"><h1>{allSucceeded ? "项目创建完成" : hasFinishedFailures ? "创建完成，但有步骤失败" : "正在创建 " + draft.brand.name}</h1><Chip tone={hasFinishedFailures ? "danger" : allSucceeded ? "ok" : "info"}>{hasFinishedFailures ? "需处理" : allSucceeded ? "完成" : completedCount + " / " + INIT_STEPS.length}</Chip></header>
        <div className="si-wizard-progress-track"><span style={{ width: progressWidth + "%" }} /></div>
        <div className="si-wizard-progress-list">{INIT_STEPS.map((key) => {
          const { name, detail } = progressSteps[key];
          const step = stateFor(key);
          const label = step.status === "ok" ? "完成" : step.status === "running" ? "进行中" : step.status === "failed" ? "失败" : "等待中";
          return <div key={key} className={`si-wizard-progress-row is-${step.status}`}>
            {step.status === "ok" ? <Check size={17} aria-hidden="true" /> : step.status === "running" ? <LoaderCircle size={17} className="si-spin" aria-hidden="true" /> : step.status === "failed" ? <CircleAlert size={17} aria-hidden="true" /> : <span className="si-wizard-progress-dot" />}
            <span><strong>{name}</strong><small>{detail}</small>{step.reason && <small className="si-wizard-step-reason" role={step.status === "failed" ? "alert" : undefined}>{step.reason}</small>}</span>
            <div className="si-wizard-step-actions"><span aria-live="polite">{label}</span>{step.status === "failed" && isRetryableStep(key) && <Button size="small" aria-label={`${name}重试`} onClick={() => void retryStep(key)}>重试</Button>}</div>
          </div>;
        })}</div>
        {globalFailure && <p className="si-form-error" role="alert">{globalFailure}</p>}
        <div className="si-wizard-done-actions"><Link className="si-button si-button-primary" to={"/p/" + draft.created.id}>打开项目</Link>{!draft.created.path && <Button disabled={busy} onClick={() => void retryReadCreatedPath()}>{busy ? "正在读取…" : "重试读取路径"}</Button>}<Button disabled={!draft.created.path} onClick={() => void openFolder()} icon={<FolderOpen size={15} />}>打开文件夹</Button><Link className="si-button" to="/skills">把 skill 安装到 Agent 平台</Link></div>
      </section>
      <section className="si-wizard-card si-wizard-tree-card"><h2>已生成的项目文件</h2><code className="si-mono">{draft.created.path ?? "实际项目路径暂不可用"}</code><pre>{draft.folderName + "/\n├── README.md        项目说明\n├── AGENTS.md / CLAUDE.md\n├── _agent/skills/   内置 skill\n└── index/           网站数据（SiteIndex 维护）\n    ├── site.json\n    ├── catalog/  inventory/  seo/\n    ├── content/  ledgers/  design/\n    └── views/ reports/ logs/"}</pre></section>
    </div>}
  </div>;
}
import "./new-project/page.css";
