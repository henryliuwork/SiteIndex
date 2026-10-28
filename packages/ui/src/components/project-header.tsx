import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import type { ProjectSummary } from "@siteindex/shared";
import { Tabs } from "./primitives";
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
}: {
  project: HeaderProject;
  activeTab: ProjectTab;
  subtitle?: string;
  status?: ReactNode;
  actions?: ReactNode;
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
    <Tabs value={activeTab} options={PROJECT_TABS} ariaLabel="项目页面" onChange={(tab) => navigate(projectTabPath(project.id, tab))} />
  </div>;
}
