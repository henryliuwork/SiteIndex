import { cloneElement, isValidElement, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import * as Popover from "@radix-ui/react-popover";
import { Cloud, MoreHorizontal } from "lucide-react";
import type { ProjectSummary } from "@siteindex/shared";
import { PageHeaderActions, type PageHeaderOverflowAction } from "./layout-primitives";
import { Button, TabPanel, Tabs } from "./primitives";
import { formatDateTime } from "./utils";
import "./project-header.css";

export const PROJECT_TABS = [
  { value: "overview", label: "概览" },
  { value: "todos", label: "待办" },
  { value: "products", label: "产品管理" },
  { value: "seo", label: "SEO" },
  { value: "content", label: "内容" },
  { value: "edm", label: "EDM" },
  { value: "design", label: "设计" },
  { value: "readme", label: "README" },
  { value: "runs", label: "运行" },
  { value: "settings", label: "设置" },
] as const;

export type ProjectTab = (typeof PROJECT_TABS)[number]["value"];
type HeaderProject = Pick<ProjectSummary, "id" | "name" | "domain" | "platform" | "storage_location" | "sync">;

export function projectTabId(projectId: ProjectSummary["id"], tab: ProjectTab): string {
  return `project-tab-${encodeURIComponent(projectId)}-${tab}`;
}

export function projectPanelId(projectId: ProjectSummary["id"], tab: ProjectTab): string {
  return `project-panel-${encodeURIComponent(projectId)}-${tab}`;
}

export function ProjectTabPanel({ projectId, tab, children }: { projectId: ProjectSummary["id"]; tab: ProjectTab; children: ReactNode }) {
  return <TabPanel id={projectPanelId(projectId, tab)} labelledBy={projectTabId(projectId, tab)}>{children}</TabPanel>;
}

function removeDuplicateSyncTime(status: ReactNode, formattedTime: string): ReactNode {
  if (!formattedTime || !isValidElement<{ children?: ReactNode }>(status)) return status;
  const children = status.props.children;
  const text = Array.isArray(children)
    ? children.map((child) => typeof child === "string" || typeof child === "number" ? String(child) : "").join("")
    : typeof children === "string" || typeof children === "number" ? String(children) : "";
  if (!text.includes(formattedTime)) return status;
  const remaining = text.replace(formattedTime, "").replace(/^[\s·•|]+|[\s·•|]+$/g, "").trim();
  return remaining ? cloneElement(status, undefined, remaining) : null;
}

function labelInventoryDataSource(pageMeta: ReactNode): ReactNode {
  if (!isValidElement<{ children?: ReactNode }>(pageMeta)) return pageMeta;
  const children = pageMeta.props.children;
  if (typeof children !== "string" || !children.startsWith("数据日期：")) return pageMeta;
  return cloneElement(pageMeta, undefined, children.replace("数据日期：", "库存数据截至："));
}

const platformLabels: Record<ProjectSummary["platform"], string> = {
  magento: "Magento",
  wordpress: "WordPress",
  woocommerce: "WooCommerce",
  shopify: "Shopify",
  other: "其他平台",
};

function projectTabPath(projectId: ProjectSummary["id"], tab: ProjectTab): string {
  if (tab === "settings") return `/p/${projectId}/settings/config`;
  return `/p/${projectId}${tab === "overview" ? "" : `/${tab}`}`;
}

export function fitProjectTabs(widths: readonly number[], available: number, activeIndex: number, gap: number, moreWidth: number): number[] {
  const indices = widths.map((_, index) => index);
  const total = widths.reduce((sum, width) => sum + width, 0) + gap * Math.max(0, widths.length - 1);
  if (total <= available) return indices;
  const visible = new Set([activeIndex]);
  let used = widths[activeIndex]! + moreWidth + gap * 2;
  for (const index of indices) {
    if (index === activeIndex) continue;
    const next = widths[index]! + gap;
    if (used + next <= available) { visible.add(index); used += next; }
  }
  return indices.filter((index) => visible.has(index));
}

let pendingProjectTabFocus: string | null = null;

function ProjectNavigation({ projectId, activeTab, hasTabPanel }: { projectId: string; activeTab: ProjectTab; hasTabPanel: boolean }) {
  const navigate = useNavigate();
  const stripRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const menuSelection = useRef(false);
  const menuItems = useRef<Array<HTMLButtonElement | null>>([]);
  const [visibleIndices, setVisibleIndices] = useState<number[]>(() => PROJECT_TABS.map((_, index) => index));
  const [open, setOpen] = useState(false);
  const activeIndex = PROJECT_TABS.findIndex(({ value }) => value === activeTab);

  useLayoutEffect(() => {
    const measure = () => {
      const strip = stripRef.current;
      const probe = measureRef.current;
      if (!strip || !probe || !strip.clientWidth) return;
      const widths = Array.from(probe.children, (item) => item.getBoundingClientRect().width);
      if (widths.some((width) => width <= 0)) return;
      const gap = Number.parseFloat(getComputedStyle(strip.querySelector(".si-tabs")!).columnGap) || 0;
      const next = fitProjectTabs(widths, strip.clientWidth, activeIndex, gap, 76);
      setVisibleIndices((current) => current.join() === next.join() ? current : next);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    if (stripRef.current) observer?.observe(stripRef.current);
    if (measureRef.current) observer?.observe(measureRef.current);
    window.addEventListener("resize", measure);
    void document.fonts?.ready.then(measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, [activeIndex]);

  useLayoutEffect(() => {
    const targetId = projectTabId(projectId, activeTab);
    if (pendingProjectTabFocus !== targetId) return;
    const focusTab = (attempt = 0) => {
      const tab = document.getElementById(targetId);
      if (tab) { tab.focus(); pendingProjectTabFocus = null; }
      else if (attempt < 30) window.requestAnimationFrame(() => focusTab(attempt + 1));
    };
    window.requestAnimationFrame(() => focusTab());
  }, [projectId, activeTab, visibleIndices]);

  const hiddenTabs = PROJECT_TABS.filter((_, index) => !visibleIndices.includes(index));
  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const current = menuItems.current.findIndex((item) => item === document.activeElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? hiddenTabs.length - 1
      : (current + (event.key === "ArrowDown" ? 1 : -1) + hiddenTabs.length) % hiddenTabs.length;
    event.preventDefault();
    menuItems.current[next]?.focus();
  };

  return <div ref={stripRef} className="si-project-tab-strip">
    <Tabs
      value={activeTab}
      options={PROJECT_TABS.filter((_, index) => visibleIndices.includes(index))}
      ariaLabel="项目页面"
      tabIdPrefix={`project-tab-${encodeURIComponent(projectId)}`}
      panelIdPrefix={hasTabPanel ? `project-panel-${encodeURIComponent(projectId)}` : undefined}
      onChange={(tab) => navigate(projectTabPath(projectId, tab))}
    />
    {hiddenTabs.length > 0 && <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild><Button size="small" variant="ghost" className="si-project-tab-more" aria-label="更多项目页面" aria-haspopup="menu" aria-expanded={open} icon={<MoreHorizontal size={16} />} >更多</Button></Popover.Trigger>
      <Popover.Portal><Popover.Content className="si-page-header-menu" role="menu" aria-label="更多项目页面" align="start" sideOffset={4} onKeyDown={onMenuKeyDown} onCloseAutoFocus={(event) => { if (menuSelection.current) event.preventDefault(); }}>
        {hiddenTabs.map(({ value, label }, index) => <button key={value} ref={(node) => { menuItems.current[index] = node; }} className="si-page-header-menu-item" type="button" role="menuitem" onClick={() => { menuSelection.current = true; pendingProjectTabFocus = projectTabId(projectId, value); navigate(projectTabPath(projectId, value)); setOpen(false); }}>{label}</button>)}
      </Popover.Content></Popover.Portal>
    </Popover.Root>}
    <div ref={measureRef} className="si-project-tab-measure" aria-hidden="true">{PROJECT_TABS.map(({ value, label }) => <span key={value}>{label}</span>)}</div>
  </div>;
}

export function ProjectHeader({
  project,
  activeTab,
  subtitle,
  status,
  pageTitle,
  pageMeta,
  actions,
  overflow,
  hasTabPanel = false,
}: {
  project: HeaderProject;
  activeTab: ProjectTab;
  subtitle?: string;
  status?: ReactNode;
  /** 页面标题移入标签栏右侧后，页面可删除单独的 PageHeader 行。 */
  pageTitle?: ReactNode;
  /** 页面标题的次要信息（例如数据日期或项目状态）。 */
  pageMeta?: ReactNode;
  actions?: ReactNode;
  overflow?: readonly PageHeaderOverflowAction[];
  hasTabPanel?: boolean;
}) {
  const projectSubtitle = subtitle ?? `${project.domain} · ${platformLabels[project.platform]}`;
  const selectedTab = activeTab;
  const syncAt = project.sync?.at ?? null;
  const formattedSyncTime = formatDateTime(syncAt);
  const syncJob = project.sync?.job;
  const recentJobLabel = !syncAt || !syncJob || syncJob === "daily" || syncJob === "weekly"
    ? "最近同步" : syncJob === "validate" ? "最近校验" : "最近运行";
  const projectStatus = removeDuplicateSyncTime(status, formattedSyncTime);
  const normalizedPageMeta = activeTab === "products" ? labelInventoryDataSource(pageMeta) : pageMeta;

  return <div className="si-project-header">
    <header className="si-project-header-row">
      <div className="si-project-header-identity">
        <h1 title={project.name}>{project.name}</h1>
        <code title={projectSubtitle}>{projectSubtitle}</code>
        <div className="si-project-header-sync">{recentJobLabel} <time dateTime={syncAt ?? undefined}>{formattedSyncTime}</time></div>
        {projectStatus && <div className="si-project-header-status">{projectStatus}</div>}
        {project.storage_location === "known_cloud_sync" && <span
          className="si-project-header-storage-warning"
          role="note"
          aria-label="此项目位于已识别的第三方同步目录，当前版本仅支持查看。请手动复制到本机存储后重新添加；SiteIndex 不会自动迁移或删除项目文件。"
          title="此项目位于已识别的第三方同步目录，当前版本仅支持查看。请手动复制到本机存储后重新添加。"
        ><Cloud size={13} aria-hidden="true" />已识别同步目录 · 只读</span>}
      </div>
    </header>
    <div className="si-project-header-tabs-row">
      <ProjectNavigation projectId={project.id} activeTab={selectedTab} hasTabPanel={hasTabPanel} />
      {(pageTitle || normalizedPageMeta) && <div className="si-project-header-page-heading">
        {pageTitle && <h2>{pageTitle}</h2>}
        {normalizedPageMeta && <div className="si-project-header-page-meta">{normalizedPageMeta}</div>}
      </div>}
      <div className="si-project-header-action-slot">
        <PageHeaderActions actions={actions} overflow={overflow} className="si-project-header-actions" />
      </div>
    </div>
  </div>;
}
