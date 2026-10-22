import { HashRouter, Link, NavLink, Route, Routes, useLocation } from "react-router-dom";
import { Activity, Boxes, FolderKanban, Settings, Sparkles } from "lucide-react";

const routes = [
  ["/new/url", "新建项目 · 网站"],
  ["/new/source", "新建项目 · 数据源"],
  ["/new/brand", "新建项目 · 品牌配置"],
  ["/new/done", "新建项目 · 完成"],
  ["/p/:id", "概览"],
  ["/p/:id/inventory", "库存"],
  ["/p/:id/products", "产品"],
  ["/p/:id/seo", "SEO"],
  ["/p/:id/content", "内容"],
  ["/p/:id/edm", "EDM"],
  ["/p/:id/design", "设计规范"],
  ["/p/:id/readme", "README"],
  ["/p/:id/runs", "运行与定时任务"],
  ["/p/:id/settings/config", "项目设置 · 配置"],
  ["/p/:id/settings/categories", "项目设置 · 分类"],
  ["/p/:id/settings/folders", "项目设置 · 文件夹"],
  ["/p/:id/settings/files", "项目设置 · 本地文件"],
  ["/skills", "Skill 中心"],
  ["/settings", "软件设置"],
] as const;

function RouteContent() {
  const path = useLocation().pathname;
  const selected = routes.find(([pattern]) => {
    const matcher = new RegExp("^" + pattern.replace(/:[^/]+/g, "[^/]+") + "$");
    return matcher.test(path);
  });
  const title = path === "/" ? "项目中心" : selected?.[1] ?? "页面";
  return (
    <section className="si-placeholder">
      <h1>{title}</h1>
      <p>页面框架已就绪，内容将在对应里程碑接入。</p>
    </section>
  );
}

function Sidebar() {
  return (
    <aside className="si-side-nav" aria-label="主导航">
      <Link to="/" className="si-brand">
        <span className="si-brand-mark" aria-hidden="true"><FolderKanban size={16} /></span>
        <span className="si-brand-name">SiteIndex</span>
      </Link>
      <NavLink to="/" end className={({ isActive }) => "si-nav-link" + (isActive ? " active" : "")}>
        <Boxes size={17} aria-hidden="true" /><span className="si-nav-label">项目中心</span>
      </NavLink>
      <NavLink to="/skills" className={({ isActive }) => "si-nav-link" + (isActive ? " active" : "")}>
        <Sparkles size={17} aria-hidden="true" /><span className="si-nav-label">Skill 中心</span>
      </NavLink>
      <NavLink to="/p/kingsyard/runs" className={({ isActive }) => "si-nav-link" + (isActive ? " active" : "")}>
        <Activity size={17} aria-hidden="true" /><span className="si-nav-label">定时任务</span>
      </NavLink>
      <NavLink to="/settings" className={({ isActive }) => "si-nav-link" + (isActive ? " active" : "")}>
        <Settings size={17} aria-hidden="true" /><span className="si-nav-label">设置</span>
      </NavLink>
      <div className="si-nav-caption">项目</div>
      <div className="si-nav-projects">
        <NavLink to="/p/kingsyard" className={({ isActive }) => "si-nav-link" + (isActive ? " active" : "")}>
          <span aria-hidden="true">●</span><span className="si-nav-label">Kingsyard</span>
        </NavLink>
      </div>
      <div className="si-runner" style={{ marginTop: "auto", padding: "12px", borderTop: "1px solid var(--color-line)", display: "grid", gap: 2 }}>
        <span style={{ color: "var(--color-muted)", fontSize: 12 }}>本机</span>
        <strong>本地开发</strong>
        <span style={{ color: "var(--color-muted)", fontSize: 12 }}>浏览器 mock 模式</span>
      </div>
    </aside>
  );
}

function AppShell() {
  return (
    <div className="si-window">
      <header className="si-title-bar">
        <span className="si-title">SiteIndex</span>
        <div className="si-window-controls" aria-hidden="true" />
      </header>
      <div className="si-layout">
        <Sidebar />
        <main className="si-content">
          <Routes>
            <Route path="*" element={<RouteContent />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <HashRouter>
      <AppShell />
    </HashRouter>
  );
}
