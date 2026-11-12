import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Cloud } from "lucide-react";
import type { ProjectSummary } from "@siteindex/shared";
import { PageHeaderActions, type PageHeaderOverflowAction } from "./layout-primitives";
import { TabPanel, Tabs } from "./primitives";
import "./project-header.css";

export const PROJECT_TABS = [
  { value: "overview", label: "概览" },
  { value: "inventory", label: "库存" },
  { value: "products", label: "产品" },
  { value: "seo", label: "SEO" },
  { value: "content", label: "内容" },
  { value: "edm", label: "EDM" },
  { value: "design", label: "设计" },
  { value: "readme", label: "README" },
  { value: "runs", label: "运行" },
  { value: "settings", label: "设置" },
] as const;

export type ProjectTab = (typeof PROJECT_TABS)[number]["value"];
type HeaderProject = Pick<ProjectSummary, "id" | "name" | "domain" | "platform" | "storage_location">;

export function projectTabId(projectId: ProjectSummary["id"], tab: ProjectTab): string {
  return `project-tab-${encodeURIComponent(projectId)}-${tab}`;
}

export function projectPanelId(projectId: ProjectSummary["id"], tab: ProjectTab): string {
  return `project-panel-${encodeURIComponent(projectId)}-${tab}`;
}

export function ProjectTabPanel({ projectId, tab, children }: { projectId: ProjectSummary["id"]; tab: ProjectTab; children: ReactNode }) {
  return <TabPanel id={projectPanelId(projectId, tab)} labelledBy={projectTabId(projectId, tab)}>{children}</TabPanel>;
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
  const navigate = useNavigate();
  const projectSubtitle = subtitle ?? `${project.domain} · ${platformLabels[project.platform]}`;

  return <div className="si-project-header">
    <header className="si-project-header-row">
      <div className="si-project-header-identity">
        <h1 title={project.name}>{project.name}</h1>
        <code title={projectSubtitle}>{projectSubtitle}</code>
        {status && <div className="si-project-header-status">{status}</div>}
        {project.storage_location === "known_cloud_sync" && <span
          className="si-project-header-storage-warning"
          role="note"
          aria-label="此项目位于已识别的第三方同步目录，当前版本仅支持查看。请手动复制到本机存储后重新添加；SiteIndex 不会自动迁移或删除项目文件。"
          title="此项目位于已识别的第三方同步目录，当前版本仅支持查看。请手动复制到本机存储后重新添加。"
        ><Cloud size={13} aria-hidden="true" />已识别同步目录 · 只读</span>}
      </div>
    </header>
    <div className="si-project-header-tabs-row">
      <Tabs
        value={activeTab}
        options={PROJECT_TABS}
        ariaLabel="项目页面"
        tabIdPrefix={`project-tab-${encodeURIComponent(project.id)}`}
        panelIdPrefix={hasTabPanel ? `project-panel-${encodeURIComponent(project.id)}` : undefined}
        onChange={(tab) => navigate(projectTabPath(project.id, tab))}
      />
      {(pageTitle || pageMeta) && <div className="si-project-header-page-heading">
        {pageTitle && <h2>{pageTitle}</h2>}
        {pageMeta && <div className="si-project-header-page-meta">{pageMeta}</div>}
      </div>}
      <div className="si-project-header-action-slot">
        <PageHeaderActions actions={actions} overflow={overflow} className="si-project-header-actions" />
      </div>
    </div>
  </div>;
}
