import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import type { ProjectSummary } from "@siteindex/shared";
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
type HeaderProject = Pick<ProjectSummary, "id" | "name" | "domain" | "platform">;

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
  actions,
  hasTabPanel = false,
}: {
  project: HeaderProject;
  activeTab: ProjectTab;
  subtitle?: string;
  status?: ReactNode;
  actions?: ReactNode;
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
      </div>
      <div className="si-project-header-actions" aria-label="项目操作">{actions}</div>
    </header>
    <Tabs
      value={activeTab}
      options={PROJECT_TABS}
      ariaLabel="项目页面"
      tabIdPrefix={`project-tab-${encodeURIComponent(project.id)}`}
      panelIdPrefix={hasTabPanel ? `project-panel-${encodeURIComponent(project.id)}` : undefined}
      onChange={(tab) => navigate(projectTabPath(project.id, tab))}
    />
  </div>;
}
