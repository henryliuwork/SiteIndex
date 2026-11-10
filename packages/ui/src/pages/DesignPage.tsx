import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy } from "lucide-react";
import { useParams } from "react-router-dom";
import type { DesignColorRole, DesignTokens, DesignTypographyScaleKey } from "@siteindex/shared";
import { PATHS } from "@siteindex/shared";
import { api, apiErrorMessage } from "../api";
import { projectQueryKeys } from "../project-queries";
import { ApiErrorNotice, Button, Chip, EmptyState, Notice, ProjectHeader, ProjectTabPanel, useToast } from "../components";

const colorRoles: { key: DesignColorRole; label: string }[] = [
  { key: "primary", label: "主色" }, { key: "secondary", label: "辅助色" },
  { key: "text", label: "正文文字" }, { key: "text_muted", label: "弱化文字" },
  { key: "background", label: "页面背景" }, { key: "surface", label: "内容表面" },
  { key: "border", label: "边框" }, { key: "sale", label: "促销" }, { key: "link", label: "链接" },
];
const typographyItems: { key: DesignTypographyScaleKey; label: string; sample: string }[] = [
  { key: "h1", label: "一级标题 H1", sample: "示例页面标题" },
  { key: "h2", label: "二级标题 H2", sample: "示例区块标题" },
  { key: "h3", label: "三级标题 H3", sample: "示例小节标题" },
  { key: "h4", label: "四级标题 H4", sample: "示例内容标题" },
  { key: "h5", label: "五级标题 H5", sample: "示例辅助标题" },
  { key: "h6", label: "六级标题 H6", sample: "示例细分标题" },
  { key: "body", label: "正文 Body", sample: "这是一段用于预览正文排版的虚构文本。" },
  { key: "small", label: "小字 Small", sample: "用于辅助说明的示例文字" },
  { key: "caption", label: "说明 Caption", sample: "图表与控件的补充说明" },
];
const textValue = (value: string | number | undefined, fallback = "—"): string => value === undefined || value === "" ? fallback : String(value);
const formatExtracted = (value: string): string => {
  const [year, month, day] = value.slice(0, 10).split("-");
  return year && month && day ? `${month}-${day}` : value;
};
function ColorCard({ tokens, onCopy, copied }: { tokens: DesignTokens | null; onCopy: (value: string) => void; copied: string }) {
  const roles = tokens?.color.roles;
  return (
    <section className="si-design-card si-design-colors">
      <h2>颜色角色</h2>
      {roles ? <div className="si-design-role-grid">
        {colorRoles.map(({ key, label }) => {
          const role = roles[key];
          return <article className="si-design-role" key={key}>
            <div className="si-design-role-swatch" aria-hidden="true" style={role ? { backgroundColor: role.value } : undefined} />
            <div className="si-design-role-content">
              <strong>{label}</strong>
              <span className="si-design-role-value">{role?.value ?? "未识别"}</span>
              {role ? <>
                <span className="si-design-role-meta">来源：<code>{role.source || "未提供"}</code></span>
                <span className="si-design-role-meta">置信度：{Math.round(role.confidence * 100)}%</span>
                <Button variant="ghost" size="small" className="si-design-copy-color" onClick={() => onCopy(role.value)}>
                  {copied === role.value ? "已复制" : "复制色值"}<Copy size={12} aria-hidden="true" />
                </Button>
              </> : <span className="si-design-role-meta">当前页面未识别此颜色角色。</span>}
            </div>
          </article>;
        })}
      </div> : <EmptyState title="暂无颜色角色数据">当前 tokens.json 尚未提供 Token v2 颜色角色。</EmptyState>}
    </section>
  );
}

function TypographyCard({ tokens }: { tokens: DesignTokens | null }) {
  const scale = tokens?.typography.scale ?? {};
  const fonts = tokens?.typography.font_families;
  const hasScale = typographyItems.some(({ key }) => Boolean(scale[key]));
  return (
    <section className="si-design-card si-design-typography">
      <h2>字体与字号层级</h2>
      <div className="si-design-font-families">
        <span>标题：<code>{fonts?.heading ?? "未识别"}</code></span>
        <span>正文：<code>{fonts?.body ?? "未识别"}</code></span>
        <span>等宽：<code>{fonts?.mono ?? "未识别"}</code></span>
      </div>
      {hasScale ? <div className="si-design-type-list">
        {typographyItems.map(({ key, label, sample }) => {
          const style = scale[key];
          const fontFamily = key === "body" || key === "small" || key === "caption" ? fonts?.body : fonts?.heading;
          return <article className="si-design-type-row" key={key}>
            <span className="si-design-type-name">{label}</span>
            {style ? <>
              <span className="si-design-type-sample" style={{ fontFamily: fontFamily || undefined, fontSize: style.size, fontWeight: style.weight, lineHeight: style.line_height, letterSpacing: style.letter_spacing }}>{sample}</span>
              <span className="si-design-type-metrics">{style.size} · 字重 {style.weight} · 行高 {style.line_height} · 字距 {textValue(style.letter_spacing)}</span>
            </> : <span className="si-design-type-missing">未识别此层级</span>}
          </article>;
        })}
      </div> : <p className="si-design-empty">暂无字号层级。当前 tokens.json 尚未提供 Token v2 字号数据。</p>}
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
  const { id = "demo" } = useParams();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [copiedColor, setCopiedColor] = useState("");
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [runMessage, setRunMessage] = useState("");
  const projectQuery = useQuery({ queryKey: projectQueryKeys.detail(id), queryFn: () => api.projects.get(id) });
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
      if (result.status === "ok") toast.success("设计规范提取已完成。");
      else toast.error(result.summary);
      void queryClient.invalidateQueries({ queryKey: ["design", id] });
    });
    return () => { unsubscribeProgress(); unsubscribeFinished(); };
  }, [activeRunId, id, queryClient, toast]);

  const openTokens = async () => {
    if (!project) return;
    try { await api.shell.openPath(project.path.replace(/[\\/]+$/, "") + "/" + PATHS.designTokens); toast.success("已打开 tokens.json。"); }
    catch (cause) { toast.error(apiErrorMessage(cause, "打开 tokens.json 失败。")); }
  };
  const copyInstruction = async () => {
    try {
      const { body } = await api.skills.get("page-design");
      await api.shell.copyText(body);
      toast.success("page-design 指令已复制。");
    } catch (cause) { toast.error(apiErrorMessage(cause, "复制 page-design 指令失败。")); }
  };
  const refresh = async () => {
    if (!project) return;
    try {
      setRunMessage("正在启动设计规范提取…");
      const run = await api.jobs.run({ projectPath: project.path, job: "design" });
      setActiveRunId(run.runId);
      toast.info("设计规范提取已启动。");
    } catch (cause) { setRunMessage(""); toast.error(apiErrorMessage(cause, "启动设计规范提取失败。")); }
  };
  const copyColor = async (value: string) => {
    try { await api.shell.copyText(value); setCopiedColor(value); toast.success(`${value} 已复制。`); }
    catch (cause) { toast.error(apiErrorMessage(cause, "复制色值失败。")); }
  };
  const openScreenshot = async (path: string) => {
    try { await api.shell.openPath(path); toast.success("已打开页面截图。"); }
    catch (cause) { toast.error(apiErrorMessage(cause, "打开截图失败。")); }
  };

  if (projectQuery.isLoading) return <div className="si-page-loading" role="status">正在加载项目信息…</div>;
  if (projectQuery.isError || !project) return <ApiErrorNotice page label="项目设计规范页面加载失败。" error={projectQuery.error} onRetry={() => void projectQuery.refetch()} />;

  return (
    <div className="si-page si-design-page">
      <ProjectHeader project={project} activeTab="design" hasTabPanel status={tokens
        ? <Chip tone="neutral">提取于 {formatExtracted(tokens.extracted_at)} · {tokens.source_pages.length} 个页面{import.meta.env.DEV ? " · 示例数据" : ""}</Chip>
        : <Chip tone="warn">尚未提取设计规范</Chip>} actions={
          <>
            <Button onClick={() => void openTokens()}>打开 tokens.json</Button>
            <Button onClick={() => void copyInstruction()}>复制 page-design 指令</Button>
            <Button variant="primary" disabled={Boolean(activeRunId)} onClick={() => void refresh()}>{activeRunId ? "提取中…" : "重新提取"}</Button>
          </>
        } />
      <ProjectTabPanel projectId={project.id} tab="design">
      {runMessage && <Notice tone="info" title={activeRunId ? "设计规范提取进行中" : "正在启动设计规范提取"}>{runMessage}</Notice>}
      {designQuery.isLoading ? <div className="si-page-loading" role="status">正在加载设计规范…</div> : designQuery.isError ? <ApiErrorNotice label="设计规范加载失败。" error={designQuery.error} onRetry={() => void designQuery.refetch()} /> : <div className="si-design-layout">
        <div className="si-design-main-column">
          <ColorCard tokens={tokens} onCopy={(value) => void copyColor(value)} copied={copiedColor} />
          <TypographyCard tokens={tokens} />
        </div>
        <aside className="si-design-side-column">
          <ComponentsCard tokens={tokens} />
          <SpacingCard tokens={tokens} />
          <ScreenshotsCard screenshots={screenshots} onOpen={(path) => void openScreenshot(path)} />
        </aside>
      </div>}
      </ProjectTabPanel>
    </div>
  );
}
import "./design/page.css";
