import { useLocation } from "react-router-dom";
import type { RouteObject } from "react-router-dom";

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

function PlaceholderPage() {
  const path = useLocation().pathname;
  const selected = routes.find(([pattern]) => {
    const matcher = new RegExp("^" + pattern.replace(/:[^/]+/g, "[^/]+") + "$");
    return matcher.test(path);
  });
  const title = path === "/" ? "项目中心" : selected?.[1] ?? "页面";
  return <section className="si-placeholder"><h1>{title}</h1><p>页面框架已就绪，内容将在对应里程碑接入。</p></section>;
}

export const route: RouteObject = { path: "*", element: <PlaceholderPage /> };
