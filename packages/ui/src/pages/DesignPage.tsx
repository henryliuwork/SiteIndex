import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy } from "lucide-react";
import { useParams } from "react-router-dom";
import { PATHS, pathsFor, type DesignButtonVariant, type DesignColorRole, type DesignTokens, type DesignTypographyScaleKey } from "@siteindex/shared";
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

const buttonVariants: { key: DesignButtonVariant; label: string; sample: string }[] = [
  { key: "primary", label: "主要按钮", sample: "立即操作" },
  { key: "secondary", label: "次要按钮", sample: "了解更多" },
  { key: "outline", label: "描边按钮", sample: "查看详情" },
];

type DesignArtifact = "tokens" | "brand";

function safeDesignArtifactPath(value: unknown): string | null {
  const allowedPaths = [PATHS.designTokens, PATHS.designBrand, pathsFor("workspace").designTokens, pathsFor("workspace").designBrand];
  return typeof value === "string" && allowedPaths.includes(value) ? value : null;
}

function projectArtifactPath(projectRoot: string, relativePath: string): string {
  return `${projectRoot.replace(/[\\/]+$/, "")}/${relativePath}`;
}

const displayValue = (value: string | number | null | undefined): string =>
  value === null || value === undefined || value === "" ? "未识别" : String(value);

const formatExtracted = (value: string): string => {
  const [year, month, day] = value.slice(0, 10).split("-");
  return year && month && day ? `${month}-${day}` : value;
};

function ColorRolesCard({ tokens, onCopy, copied }: { tokens: DesignTokens | null; onCopy: (value: string) => void; copied: string }) {
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
              <span className="si-design-type-sample" style={{
                fontFamily: fontFamily || undefined,
                fontSize: style.size,
                fontWeight: style.weight,
                lineHeight: style.line_height,
                letterSpacing: style.letter_spacing,
              }}>{sample}</span>
              <span className="si-design-type-metrics">
                {style.size} · 字重 {style.weight} · 行高 {style.line_height} · 字距 {displayValue(style.letter_spacing)}
              </span>
            </> : <span className="si-design-type-missing">未识别此层级</span>}
          </article>;
        })}
      </div> : <EmptyState title="暂无字号层级">提取结果尚未提供 h1–h6、正文、小字或说明字号。</EmptyState>}
    </section>
  );
}

function ButtonsCard({ tokens }: { tokens: DesignTokens | null }) {
  const buttons = tokens?.buttons;
  return (
    <section className="si-design-card si-design-buttons">
      <h2>按钮规范</h2>
      {buttons ? <div className="si-design-button-list">
        {buttonVariants.map(({ key, label, sample }) => {
          const button = buttons[key];
          if (!button) return <article className="si-design-button-variant" key={key}>
            <h3>{label}</h3><EmptyState title="未识别此按钮变体">Core 没有返回可用的样式数据。</EmptyState>
          </article>;
          const hasVisualStyle = [button.background, button.text_color, button.border]
            .some((value) => typeof value === "string" && value.trim().length > 0);
          const previewStyle: CSSProperties = {
            backgroundColor: button.background ?? undefined,
            color: button.text_color ?? undefined,
            border: button.border ?? undefined,
            borderRadius: button.border_radius ?? undefined,
            padding: button.padding ?? undefined,
            fontSize: button.font_size ?? undefined,
            fontWeight: button.font_weight ?? undefined,
          };
          const properties: [string, string | number | null | undefined][] = [
            ["背景", button.background], ["文字", button.text_color], ["边框", button.border],
            ["圆角", button.border_radius], ["内边距", button.padding], ["字号", button.font_size],
            ["字重", button.font_weight], ["悬停背景", button.hover_background],
          ];
          return <article className="si-design-button-variant" key={key}>
            <div className="si-design-button-heading">
              <h3>{label}</h3>
              {hasVisualStyle && <span className="si-design-button-sample" style={previewStyle}>{sample}</span>}
            </div>
            {!hasVisualStyle && <EmptyState title="未识别此按钮变体">Core 未返回背景、文字颜色或边框，无法绘制可靠预览。</EmptyState>}
            <dl className="si-design-button-properties">
              {properties.map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{displayValue(value)}</dd></div>)}
            </dl>
          </article>;
        })}
      </div> : <EmptyState title="暂无按钮规范">当前 tokens.json 尚未提供 Token v2 按钮样式。</EmptyState>}
    </section>
  );
}

function CssVariablesCard({ tokens }: { tokens: DesignTokens | null }) {
  const variables = Object.entries(tokens?.css_variables ?? {}).sort(([left], [right]) => left.localeCompare(right));
  return (
    <details className="si-design-card si-design-css-variables">
      <summary><span>原始 CSS 变量</span><Chip tone="neutral">{variables.length}</Chip></summary>
      {variables.length ? <dl className="si-design-variable-list">
        {variables.map(([name, value]) => <div key={name}><dt><code>{name}</code></dt><dd><code>{value}</code></dd></div>)}
      </dl> : <EmptyState title="暂无 CSS 变量">提取结果没有返回原始 CSS 变量。</EmptyState>}
    </details>
  );
}

function ScreenshotsCard({ screenshots, onOpen }: { screenshots: { name: string; path: string }[]; onOpen: (path: string) => void }) {
  return (
    <section className="si-design-card si-design-screenshots">
      <h2>页面截图 · {screenshots.length}</h2>
      {screenshots.length ? <div className="si-design-screenshot-grid">
        {screenshots.map((screen) => <Button variant="secondary" size="small" key={screen.path} onClick={() => onOpen(screen.path)} title={`打开 ${screen.path}`}>{screen.name}</Button>)}
      </div> : <EmptyState title="暂无页面截图">提取完成后会显示网站截图。</EmptyState>}
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
  const artifactPaths = designQuery.data?.artifact_paths;
  const safeArtifactPaths: Record<DesignArtifact, string | null> = {
    tokens: safeDesignArtifactPath(artifactPaths?.tokens),
    brand: safeDesignArtifactPath(artifactPaths?.brand),
  };
  const missingArtifactLabels = (Object.entries({ tokens: "tokens.json", brand: "brand.md" }) as [DesignArtifact, string][])
    .filter(([key]) => !safeArtifactPaths[key])
    .map(([, label]) => label);

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

  const copyTokens = async () => {
    if (!tokens) return;
    try {
      await api.shell.copyText(JSON.stringify(tokens, null, 2));
      toast.success("Token JSON 已复制，可交给 agent 使用。");
    } catch (cause) { toast.error(apiErrorMessage(cause, "复制 Token JSON 失败。")); }
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
  const openDesignArtifact = async (artifact: DesignArtifact) => {
    const relativePath = safeArtifactPaths[artifact];
    if (!project || !relativePath) return;
    try {
      await api.shell.openPath(projectArtifactPath(project.path, relativePath));
      toast.success(`已打开 ${artifact === "tokens" ? "tokens.json" : "brand.md"}。`);
    } catch (cause) { toast.error(apiErrorMessage(cause, `打开 ${artifact === "tokens" ? "tokens.json" : "brand.md"} 失败。`)); }
  };

  if (projectQuery.isLoading) return <div className="si-page-loading" role="status">正在加载项目信息…</div>;
  if (projectQuery.isError || !project) return <ApiErrorNotice page label="项目设计规范页面加载失败。" error={projectQuery.error} onRetry={() => void projectQuery.refetch()} />;

  return (
    <div className="si-page si-design-page">
      <ProjectHeader project={project} activeTab="design" hasTabPanel status={tokens
        ? <Chip tone="neutral">提取于 {formatExtracted(tokens.extracted_at)} · {tokens.source_pages.length} 个页面{import.meta.env.DEV ? " · 示例数据" : ""}</Chip>
        : <Chip tone="warn">尚未提取设计规范</Chip>} actions={
          <>
            <Button variant="secondary" disabled={!tokens} onClick={() => void copyTokens()}>复制 Token（JSON）</Button>
            <Button variant="primary" disabled={Boolean(activeRunId)} onClick={() => void refresh()}>{activeRunId ? "提取中…" : "重新提取"}</Button>
          </>
        } overflow={[
          ...(safeArtifactPaths.tokens ? [{ label: "打开 tokens.json", onSelect: () => void openDesignArtifact("tokens") }] : []),
          ...(safeArtifactPaths.brand ? [{ label: "打开 brand.md", onSelect: () => void openDesignArtifact("brand") }] : []),
        ]} />
      <ProjectTabPanel projectId={project.id} tab="design">
        {runMessage && <Notice tone="info" title={activeRunId ? "设计规范提取进行中" : "正在启动设计规范提取"}>{runMessage}</Notice>}
        {designQuery.data && missingArtifactLabels.length > 0 && <Notice tone="warn" title="部分设计文件无法打开">
          Core 未提供受支持的固定相对路径：{missingArtifactLabels.join("、")}。请更新数据后重试。
        </Notice>}
        {designQuery.isLoading ? <div className="si-page-loading" role="status">正在加载设计规范…</div>
          : designQuery.isError ? <ApiErrorNotice label="设计规范加载失败。" error={designQuery.error} onRetry={() => void designQuery.refetch()} />
            : <div className="si-design-layout">
              <div className="si-design-main-column">
                <ColorRolesCard tokens={tokens} onCopy={(value) => void copyColor(value)} copied={copiedColor} />
                <TypographyCard tokens={tokens} />
              </div>
              <aside className="si-design-side-column">
                <ButtonsCard tokens={tokens} />
                <CssVariablesCard tokens={tokens} />
                <ScreenshotsCard screenshots={screenshots} onOpen={(path) => void openScreenshot(path)} />
              </aside>
            </div>}
      </ProjectTabPanel>
    </div>
  );
}

import "./design/page.css";
