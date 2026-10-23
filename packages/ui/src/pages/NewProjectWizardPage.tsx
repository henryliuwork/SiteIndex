import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CircleAlert, FolderOpen, LoaderCircle, Plus, X } from "lucide-react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import type { DetectResult, FeedInspectResult, JobProgress, JobResult, Platform } from "@siteindex/shared";
import { api } from "../api";
import { Button, Chip } from "../components";
import { defaultWorkspaceFolders, useWizardDraft } from "./wizard-state";

const steps = [
  { path: "/new/url", label: "网址" },
  { path: "/new/source", label: "数据源" },
  { path: "/new/brand", label: "品牌配置" },
  { path: "/new/done", label: "完成" },
];
const platformNames: Record<Platform, string> = { magento: "Magento", wordpress: "WordPress", woocommerce: "WooCommerce", shopify: "Shopify", other: "其他平台" };
const progressSteps = [
  ["创建文件夹结构", "index/、_agent/ 与工作区文件夹"],
  ["写入配置", "index/site.json"],
  ["生成 README", "README.md、AGENTS.md、CLAUDE.md"],
  ["分发 skill", "_agent/skills/"],
  ["首次每日同步", "Feed → SKU 与库存基线"],
  ["首次每周同步", "Sitemap → 页面与 SEO 数据"],
  ["生成视图并校验", "检查生成的数据文件"],
  ["注册定时任务", "为项目启用计划任务"],
];

function slugFor(url: string): string {
  try { return new URL(/^https?:\/\//i.test(url) ? url : "https://" + url).hostname.replace(/^www\./, "").split(".")[0]?.toLowerCase().replace(/[^a-z0-9-]+/g, "-") ?? "new-project"; }
  catch { return "new-project"; }
}

function pathJoin(root: string, folder: string): string {
  const cleanRoot = root.replace(/[\\/]+$/, "");
  return cleanRoot + (root.includes("\\") ? "\\" : "/") + folder;
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
  const [feedback, setFeedback] = useState("");
  const [uspDraft, setUspDraft] = useState("");
  const [progress, setProgress] = useState<JobProgress | null>(null);
  const [finished, setFinished] = useState<JobResult | null>(null);
  const active = Math.max(0, steps.findIndex((step) => pathname.endsWith(step.path)));

  useEffect(() => { setError(""); setFeedback(""); }, [pathname]);
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
    if (active !== 3 || !draft.created) return;
    const onProgress = api.jobs.onProgress((event) => { if (event.runId === draft.created?.runId) setProgress(event); });
    const onFinished = api.jobs.onFinished((result) => { if (result.runId === draft.created?.runId) setFinished(result); });
    return () => { onProgress(); onFinished(); };
  }, [active, draft.created]);

  const detectSite = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(""); setFeedback("");
    try {
      const result = await api.projects.detect(draft.url.trim());
      const brandName = draft.brand.name || slugFor(draft.url).replace(/(^|-)([a-z])/g, (_match, _dash, letter: string) => letter.toUpperCase());
      update({ detect: result, feedUrls: result.feed_candidates, feedResult: null, folderName: draft.folderName || slugFor(draft.url), brand: { ...draft.brand, name: brandName } });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "网站检测失败，请重试。"); }
    finally { setBusy(false); }
  };

  const inspectFeed = async () => {
    const feedUrls = draft.feedUrls.map((url) => url.trim()).filter(Boolean);
    if (!feedUrls.length) { setError("请输入至少一个 GMC feed 地址。"); return false; }
    setBusy(true); setError("");
    try {
      const result = await api.projects.inspectFeed(feedUrls, { sku_field: draft.skuField, category_depth: draft.categoryDepth });
      update({ feedUrls, feedResult: result }); return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Feed 检测失败，请检查地址后重试。"); return false; }
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
        workspace_folders: draft.workspaceFolders,
      });
      update({ projectsRoot: root, created });
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      navigate("/new/done");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "创建项目失败，请重试。"); }
    finally { setBusy(false); }
  };

  const openFolder = async () => {
    try { await api.shell.openPath(pathJoin(draft.projectsRoot || settings.data?.projects_root || "", draft.folderName)); setFeedback("已打开项目文件夹。"); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "打开文件夹失败。"); }
  };

  if (active === 3 && !draft.created) return <Navigate to="/new/brand" replace />;
  const detection = draft.detect;
  const path = pathJoin(draft.projectsRoot || settings.data?.projects_root || "D:/SiteIndex/projects", draft.folderName || "[文件夹名]");
  const pct = finished?.status === "ok" ? 100 : progress?.pct ?? 0;
  const completedCount = Math.floor(pct / 100 * progressSteps.length);

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
          <div className="si-wizard-field"><div className="si-wizard-feed-heading"><label>GMC 商品 Feed 地址</label>{!draft.feedUrls.length && <Button size="small" onClick={() => update({ feedUrls: [""], feedResult: null })}><Plus size={14} />添加 Feed</Button>}</div>{draft.feedUrls.map((url, index) => <div className="si-wizard-feed-input" key={index}><input className="si-text-field si-mono" value={url} onChange={(event) => update({ feedUrls: draft.feedUrls.map((item, itemIndex) => itemIndex === index ? event.target.value : item), feedResult: null })} placeholder="https://example.com/feed.xml" aria-label={"Feed 地址 " + (index + 1)} />{draft.feedUrls.length > 1 && <Button aria-label="移除此 Feed" onClick={() => update({ feedUrls: draft.feedUrls.filter((_, itemIndex) => itemIndex !== index), feedResult: null })}><X size={14} /></Button>}{index === 0 && <><Button variant="primary" disabled={busy || !url.trim()} onClick={() => void inspectFeed()}>{busy ? "正在检测…" : draft.feedResult ? "重新检测" : "检测 Feed"}</Button><Button size="small" aria-label="添加 Feed" title="添加 Feed" onClick={() => update({ feedUrls: [...draft.feedUrls, ""], feedResult: null })}><Plus size={14} /></Button></>}</div>)}
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
          <div className="si-wizard-path"><span>将创建</span><code>{path}</code></div>
          <fieldset className="si-wizard-folders"><legend>工作区文件夹</legend>{defaultWorkspaceFolders.map((folder) => <label key={folder.name}><input type="checkbox" checked={draft.workspaceFolders.includes(folder.name)} onChange={(event) => update({ workspaceFolders: event.target.checked ? [...draft.workspaceFolders, folder.name] : draft.workspaceFolders.filter((name) => name !== folder.name) })} /><code>{folder.name}/</code><span>{folder.description}</span><Chip>默认</Chip></label>)}</fieldset>
          <p className="si-wizard-note">创建后可在 项目设置 › 文件夹 中修改说明、新建或删除自定义文件夹。</p>
        </section>
      </div>
      {error && <p className="si-form-error" role="alert">{error}</p>}
      <footer className="si-wizard-actions"><Button onClick={() => navigate("/new/source")}>上一步</Button><Button variant="primary" onClick={() => void createProject()} disabled={busy}>{busy ? "正在创建…" : "创建项目"}</Button></footer>
    </>}

    {active === 3 && draft.created && <div className="si-wizard-done-layout">
      <section className="si-wizard-card si-wizard-progress-card">
        <header className="si-wizard-progress-heading"><h1>{finished?.status === "failed" ? "创建过程中遇到问题" : finished ? "项目创建完成" : "正在创建 " + draft.brand.name}</h1><Chip tone={finished?.status === "failed" ? "danger" : finished ? "ok" : "info"}>{finished?.status === "failed" ? "需处理" : finished ? "完成" : completedCount + " / " + progressSteps.length}</Chip></header>
        <div className="si-wizard-progress-track"><span style={{ width: pct + "%" }} /></div>
        <div className="si-wizard-progress-list">{progressSteps.map(([name, detail], index) => {
          const done = index < completedCount || finished?.status === "ok";
          const running = !finished && index === completedCount;
          return <div key={name} className="si-wizard-progress-row">{done ? <Check size={17} /> : running ? <LoaderCircle size={17} className="si-spin" /> : <span className="si-wizard-progress-dot" />}<span><strong>{name}</strong><small>{detail}</small></span><time>{done ? "完成" : running ? progress?.step ?? "进行中" : "等待中"}</time></div>;
        })}</div>
        {finished?.status === "failed" && <p className="si-form-error" role="alert">{finished.errors?.join("；") || finished.summary}</p>}
        <div className="si-wizard-done-actions"><Link className="si-button si-button-primary" to={"/p/" + draft.created.id}>打开项目</Link><Button onClick={() => void openFolder()} icon={<FolderOpen size={15} />}>打开文件夹</Button><Link className="si-button" to="/skills">把 skill 安装到 Agent 平台</Link></div>
      </section>
      <section className="si-wizard-card si-wizard-tree-card"><h2>已生成的工作区</h2><code className="si-mono">{path}</code><pre>{draft.folderName + "/\n├── README.md        项目说明\n├── AGENTS.md / CLAUDE.md\n├── _agent/skills/   内置 skill\n├── index/           网站数据（SiteIndex 维护）\n│   ├── site.json\n│   ├── catalog/  inventory/  seo/\n│   ├── content/  ledgers/  design/\n│   └── views/ reports/ logs/\n" + draft.workspaceFolders.map((folder, index) => (index === draft.workspaceFolders.length - 1 ? "└── " : "├── ") + folder + "/").join("\n")}</pre></section>
    </div>}
  </div>;
}
import "./new-project/page.css";
