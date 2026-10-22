import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import type { DesignTokens } from "@siteindex/shared";
import { PATHS } from "@siteindex/shared";
import { api } from "../api";
import { Button, Chip, Tabs } from "../components";

const tabOptions = [
  { value: "overview", label: "概览" }, { value: "inventory", label: "库存" },
  { value: "products", label: "产品" }, { value: "seo", label: "SEO" },
  { value: "content", label: "内容" }, { value: "edm", label: "EDM" },
  { value: "design", label: "设计" }, { value: "readme", label: "README" },
  { value: "runs", label: "运行" }, { value: "settings", label: "设置" },
] as const;

type ColorKey = "primary" | "text" | "text_muted" | "background" | "surface" | "border" | "sale";
const colorItems: { key: ColorKey; label: string }[] = [
  { key: "primary", label: "primary" }, { key: "text", label: "text" },
  { key: "text_muted", label: "text_muted" }, { key: "background", label: "background" },
  { key: "surface", label: "surface" }, { key: "border", label: "border" }, { key: "sale", label: "sale" },
];
const typeSamples: Record<string, string> = {
  h1: "Feed the birds", h2: "Squirrel-proof feeders", h3: "Easy to clean",
  body: "Durable feeders and baths for backyard birders.", small: "Free shipping over $49",
};
const typographyNames: Record<string, string> = { h1: "h1", h2: "h2", h3: "h3", body: "body", small: "small" };
const textValue = (value: string | number | undefined, fallback = "—"): string => value === undefined || value === "" ? fallback : String(value);
const foregroundFor = (hex: string | null | undefined): string => hex && /^#[0-9a-f]{6}$/i.test(hex) && Number.parseInt(hex.slice(1), 16) > 0x999999 ? "#222222" : "#FFFFFF";
const formatExtracted = (value: string): string => {
  const [year, month, day] = value.slice(0, 10).split("-");
  return year && month && day ? `${month}-${day}` : value;
};
const projectTabsHref = (id: string, value: string): string => value === "settings" ? `/p/${id}/settings/config` : `/p/${id}${value === "overview" ? "" : "/" + value}`;

function ProjectHeading({ project, tokens, onOpenTokens, onCopyInstruction, onRefresh, onNavigate, refreshing }: {
  project: { name: string; domain: string; platform: string; path: string };
  tokens: DesignTokens | null;
  onOpenTokens: () => void;
  onCopyInstruction: () => void;
  onRefresh: () => void;
  onNavigate: (value: string) => void;
  refreshing: boolean;
}) {
  const platformNames: Record<string, string> = { magento: "Magento", shopify: "Shopify", wordpress: "WordPress", woocommerce: "WooCommerce", other: "其他平台" };
  return (
    <>
      <header className="si-project-page-heading">
        <div className="si-project-title-line si-design-title-line">
          <h1>{project.name}</h1><code>{project.domain} · {platformNames[project.platform] ?? project.platform}</code>
          {tokens
            ? <Chip tone="neutral">提取于 {formatExtracted(tokens.extracted_at)} · {tokens.source_pages.length} 个页面{import.meta.env.DEV ? " · 示例数据" : ""}</Chip>
            : <Chip tone="warn">尚未提取设计规范</Chip>}
        </div>
        <div className="si-page-actions">
          <Button onClick={onOpenTokens}>打开 tokens.json</Button>
          <Button onClick={onCopyInstruction}>复制 page-design 指令</Button>
          <Button variant="primary" disabled={refreshing} onClick={onRefresh}>{refreshing ? "提取中…" : "重新提取"}</Button>
        </div>
      </header>
      <Tabs value="design" options={tabOptions} ariaLabel="项目页面" onChange={onNavigate} />
    </>
  );
}

function ColorCard({ tokens, onCopy, copied }: { tokens: DesignTokens | null; onCopy: (value: string) => void; copied: string }) {
  const colors = tokens?.color;
  const palette = colors?.palette ?? [];
  const paletteMax = Math.max(1, ...palette.map(({ count }) => count));
  return (
    <section className="si-design-card si-design-colors">
      <h2>颜色</h2>
      <div className="si-design-swatches">
        {colorItems.map(({ key, label }) => {
          const value = colors?.[key] ?? null;
          return (
            <button className="si-design-swatch" type="button" key={key} disabled={!value} onClick={() => value && onCopy(value)} title={value ? `点击复制 ${value}` : "尚无色值"}>
              <span className="si-design-swatch-color" style={{ background: value ?? "transparent", color: foregroundFor(value) }}>{!value && "—"}</span>
              <strong>{label}</strong>
              <span className="si-design-hex">{value ? (copied === value ? "已复制" : value) : "—"}<Copy size={11} aria-hidden="true" /></span>
            </button>
          );
        })}
      </div>
      <div className="si-design-palette-block">
        <span className="si-design-caption">使用频率前 12（palette）</span>
        {palette.length > 0
          ? <div className="si-design-palette" role="img" aria-label="颜色使用频率色带">{palette.slice(0, 12).map((item, index) => <span key={item.value + index} style={{ background: item.value, flexGrow: item.count / paletteMax }} title={`${item.value} · ${item.count} 次`} />)}</div>
          : <p className="si-design-empty">提取后显示颜色频率。</p>}
      </div>
    </section>
  );
}

function TypographyCard({ tokens }: { tokens: DesignTokens | null }) {
  const scale = tokens?.typography.scale ?? {};
  const headingFont = tokens?.typography.font_families.heading ?? "serif";
  const bodyFont = tokens?.typography.font_families.body ?? "sans-serif";
  const order = ["h1", "h2", "h3", "body", "small"];
  const rows = order.filter((key) => scale[key]);
  return (
    <section className="si-design-card si-design-typography">
      <div className="si-design-section-heading"><h2>字体</h2><span className="si-design-caption">标题 <code>{headingFont}</code> · 正文 <code>{bodyFont}</code></span></div>
      {rows.length > 0 ? rows.map((key) => {
        const style = scale[key];
        if (!style) return null;
        return <div className="si-design-type-row" key={key}>
          <span className="si-design-caption si-design-type-name">{typographyNames[key] ?? key}</span>
          <span className="si-design-type-sample" style={{ fontFamily: key === "body" || key === "small" ? bodyFont : headingFont, fontSize: style.size, fontWeight: style.weight, lineHeight: style.line_height }}>{typeSamples[key] ?? key}</span>
          <span className="si-design-caption si-design-type-metrics">{style.size.replace(/px$/, "")} / {style.line_height.replace(/px$/, "")} · {style.weight}</span>
        </div>;
      }) : <p className="si-design-empty">提取后显示字体与字号阶梯。</p>}
    </section>
  );
}

function ComponentsCard({ tokens }: { tokens: DesignTokens | null }) {
  const components = tokens?.components ?? {};
  const primary = components.button_primary ?? {};
  const secondary = components.button_secondary ?? {};
  const input = components.input ?? {};
  const color = tokens?.color.primary ?? "#1E6B52";
  const primaryBg = textValue(primary.background, color);
  const primaryText = textValue(primary.color, "#FFFFFF");
  const secondaryBorder = textValue(secondary.border, `1px solid ${color}`);
  const inputBorder = textValue(input.border, textValue(input.border_color, tokens?.color.border ?? "#E5E2DA"));
  const inputBorderStyle = inputBorder.includes("solid") ? inputBorder : `1px solid ${inputBorder}`;
  const primaryDescription = `button_primary · ${primaryBg} / ${primaryText} · 圆角 ${textValue(primary.radius)} · 内边距 ${textValue(primary.padding)} · ${textValue(primary.weight)}`;
  const inputDescription = `input · 边框 ${inputBorder.replace(/^.*solid\s+/, "")} · 圆角 ${textValue(input.radius)} · 高 ${textValue(input.height)}`;
  return (
    <section className="si-design-card si-design-components">
      <h2>组件</h2>
      <div className="si-design-button-previews">
        <span style={{ background: primaryBg, color: primaryText, borderRadius: textValue(primary.radius, "4px"), padding: textValue(primary.padding, "12px 24px"), fontWeight: Number(primary.weight) || 600 }}>Add to Cart</span>
        <span style={{ background: textValue(secondary.background, "#FFFFFF"), color: textValue(secondary.color, color), border: secondaryBorder, borderRadius: textValue(secondary.radius, "4px"), padding: textValue(secondary.padding, "12px 24px"), fontWeight: Number(secondary.weight) || 600 }}>Learn more</span>
      </div>
      <div className="si-design-spec">{primaryDescription}</div>
      <span className="si-design-input-preview" style={{ border: inputBorderStyle, borderRadius: textValue(input.radius, "4px"), minHeight: textValue(input.height, "44px"), padding: textValue(input.padding, "0 14px"), color: textValue(input.color, tokens?.color.text_muted ?? "#6B6B6B") }}>Enter your email</span>
      <div className="si-design-spec">{inputDescription}</div>
    </section>
  );
}

function SpacingCard({ tokens }: { tokens: DesignTokens | null }) {
  return (
    <section className="si-design-card si-design-spacing">
      <h2>间距 · 圆角 · 阴影</h2>
      <div className="si-design-token-chips">{(tokens?.spacing ?? []).map((value) => <Chip key={value} className="si-design-mono">{value}</Chip>)}</div>
      <div className="si-design-token-chips">{(tokens?.radius ?? []).map((value) => <Chip key={value} className="si-design-mono">r {value}</Chip>)}</div>
      <div className="si-design-shadow-values">{(tokens?.shadow ?? []).map((value) => <code key={value}>shadow · {value}</code>)}</div>
      {!tokens && <p className="si-design-empty">提取后显示间距、圆角和阴影值。</p>}
    </section>
  );
}

function ScreenshotsCard({ screenshots, onOpen }: { screenshots: { name: string; path: string }[]; onOpen: (path: string) => void }) {
  return (
    <section className="si-design-card si-design-screenshots">
      <h2>页面截图 · {screenshots.length}</h2>
      {screenshots.length > 0
        ? <div className="si-design-screenshot-grid">{screenshots.map((screen) => <button type="button" key={screen.path} onClick={() => onOpen(screen.path)} title={`打开 ${screen.path}`}>{screen.name}</button>)}</div>
        : <p className="si-design-empty">提取后显示网站桌面端和移动端截图。</p>}
    </section>
  );
}

export function DesignPage() {
  const { id = "kingsyard" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [feedback, setFeedback] = useState("");
  const [copiedColor, setCopiedColor] = useState("");
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [runMessage, setRunMessage] = useState("");
  const projectQuery = useQuery({ queryKey: ["project", id], queryFn: () => api.projects.get(id) });
  const designQuery = useQuery({ queryKey: ["design", id], queryFn: () => api.design.get(id) });
  const project = projectQuery.data?.summary;
  const tokens = designQuery.data?.tokens ?? null;
  const screenshots = useMemo(() => designQuery.data?.screenshots ?? [], [designQuery.data?.screenshots]);

  useEffect(() => {
    if (!activeRunId) return;
    const unsubscribeProgress = api.jobs.onProgress((progress) => {
      if (progress.runId === activeRunId) setRunMessage(progress.message);
    });
    const unsubscribeFinished = api.jobs.onFinished((result) => {
      if (result.runId !== activeRunId) return;
      setActiveRunId(null);
      setRunMessage("");
      setFeedback(result.status === "ok" ? "设计规范提取已完成。" : result.summary);
      void queryClient.invalidateQueries({ queryKey: ["design", id] });
    });
    return () => { unsubscribeProgress(); unsubscribeFinished(); };
  }, [activeRunId, id, queryClient]);

  const openTokens = async () => {
    if (!project) return;
    try { await api.shell.openPath(project.path.replace(/[\\/]+$/, "") + "/" + PATHS.designTokens); setFeedback("已打开 tokens.json。"); }
    catch (cause) { setFeedback(cause instanceof Error ? cause.message : "打开 tokens.json 失败。"); }
  };
  const copyInstruction = async () => {
    try {
      const { body } = await api.skills.get("page-design");
      await api.shell.copyText(body);
      setFeedback("page-design 指令已复制。");
    } catch (cause) { setFeedback(cause instanceof Error ? cause.message : "复制 page-design 指令失败。"); }
  };
  const refresh = async () => {
    if (!project) return;
    try {
      setFeedback(""); setRunMessage("正在启动设计规范提取…");
      const run = await api.jobs.run({ projectPath: project.path, job: "design" });
      setActiveRunId(run.runId);
    } catch (cause) { setRunMessage(""); setFeedback(cause instanceof Error ? cause.message : "启动设计规范提取失败。"); }
  };
  const copyColor = async (value: string) => {
    try { await api.shell.copyText(value); setCopiedColor(value); setFeedback(`${value} 已复制。`); }
    catch (cause) { setFeedback(cause instanceof Error ? cause.message : "复制色值失败。"); }
  };
  const openScreenshot = async (path: string) => {
    try { await api.shell.openPath(path); }
    catch (cause) { setFeedback(cause instanceof Error ? cause.message : "打开截图失败。"); }
  };

  if (projectQuery.isLoading || designQuery.isLoading) return <div className="si-page-loading" role="status">正在加载设计规范…</div>;
  if (projectQuery.isError || designQuery.isError || !project) return <div className="si-page-error" role="alert">设计规范加载失败。<button type="button" onClick={() => { void projectQuery.refetch(); void designQuery.refetch(); }}>重试</button></div>;

  return (
    <div className="si-page si-design-page">
      <ProjectHeading project={project} tokens={tokens} onOpenTokens={() => void openTokens()} onCopyInstruction={() => void copyInstruction()} onRefresh={() => void refresh()} onNavigate={(value) => navigate(projectTabsHref(id, value))} refreshing={Boolean(activeRunId)} />
      {feedback && <p className="si-feedback" role="status">{feedback}</p>}
      {runMessage && <div className="si-sync-progress" role="status">{runMessage}</div>}
      <div className="si-design-layout">
        <div className="si-design-main-column">
          <ColorCard tokens={tokens} onCopy={(value) => void copyColor(value)} copied={copiedColor} />
          <TypographyCard tokens={tokens} />
        </div>
        <aside className="si-design-side-column">
          <ComponentsCard tokens={tokens} />
          <SpacingCard tokens={tokens} />
          <ScreenshotsCard screenshots={screenshots} onOpen={(path) => void openScreenshot(path)} />
        </aside>
      </div>
    </div>
  );
}
