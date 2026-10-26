import { useEffect, useState, type ReactNode } from "react";
import { Activity, Boxes, FolderKanban, PanelLeftClose, PanelLeftOpen, Settings, Sparkles } from "lucide-react";
import { Link, NavLink, useLocation } from "react-router-dom";

export interface SideNavProject {
  id: string;
  name: string;
  state?: "ok" | "partial" | "failed" | "never" | "running";
}

interface WindowChromeProps {
  platform: "win32" | "darwin";
  children: ReactNode;
}

export function WindowChrome({ platform, children }: WindowChromeProps) {
  return (
    <div className="si-window">
      <header className={"si-title-bar si-title-bar-" + (platform === "darwin" ? "mac" : "win")}>
        <span className="si-title">SiteIndex</span>
      </header>
      {children}
    </div>
  );
}

interface SideNavProps {
  projects?: SideNavProject[];
  runnerName?: string | null;
  runnerProject?: string | null;
}

export function SideNav({ projects = [], runnerName, runnerProject }: SideNavProps) {
  const [collapsed, setCollapsed] = useState(() => typeof window !== "undefined" && window.innerWidth <= 1100);
  const { pathname } = useLocation();
  const navClass = ({ isActive }: { isActive: boolean }): string => "si-nav-link" + (isActive ? " active" : "");

  useEffect(() => {
    const media = window.matchMedia("(max-width: 1100px)");
    const updateCollapsed = () => setCollapsed(media.matches);
    updateCollapsed();
    media.addEventListener("change", updateCollapsed);
    return () => media.removeEventListener("change", updateCollapsed);
  }, []);

  return (
    <aside className={"si-side-nav" + (collapsed ? " is-collapsed" : "")} aria-label="主导航">
      <Link to="/" className="si-brand" title="SiteIndex">
        <span className="si-brand-mark" aria-hidden="true"><FolderKanban size={16} /></span>
        <span className="si-brand-name">SiteIndex</span>
      </Link>
      <button
        className="si-collapse-toggle"
        type="button"
        aria-label={collapsed ? "展开导航" : "折叠导航"}
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((value) => !value)}
      >
        {collapsed ? <PanelLeftOpen size={16} aria-hidden="true" /> : <PanelLeftClose size={16} aria-hidden="true" />}
        <span>{collapsed ? "展开导航" : "折叠导航"}</span>
      </button>
      <NavLink to="/" end className={navClass} title="项目中心">
        <Boxes size={17} aria-hidden="true" /><span className="si-nav-label">项目中心</span>
      </NavLink>
      <NavLink to="/skills" className={navClass} title="Skill 中心">
        <Sparkles size={17} aria-hidden="true" /><span className="si-nav-label">Skill 中心</span>
      </NavLink>
      <NavLink to="/p/kingsyard/runs" className={navClass} title="定时任务">
        <Activity size={17} aria-hidden="true" /><span className="si-nav-label">定时任务</span>
      </NavLink>
      <NavLink to="/settings" className={navClass} title="设置">
        <Settings size={17} aria-hidden="true" /><span className="si-nav-label">设置</span>
      </NavLink>
      <div className="si-nav-caption">项目</div>
      <div className="si-nav-projects">
        {projects.map((project) => (
          <NavLink key={project.id} to={"/p/" + project.id + "/inventory"} className={({ isActive }) => "si-nav-link" + (isActive || pathname === "/p/" + project.id || pathname.startsWith("/p/" + project.id + "/") ? " active" : "")} title={project.name}>
            <span className={"si-project-indicator si-project-indicator-" + (project.state ?? "ok")} aria-hidden="true" />
            <span className="si-nav-label">{project.name}</span>
          </NavLink>
        ))}
      </div>
      <div className="si-runner">
        <span>本机</span>
        <strong>{runnerName ?? "本地开发"}</strong>
        <span>{runnerProject ? runnerProject + " 的执行设备" : "浏览器 mock 模式"}</span>
      </div>
    </aside>
  );
}
