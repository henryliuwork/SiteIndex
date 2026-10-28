import { Link } from "react-router-dom";
import type { RouteObject } from "react-router-dom";

function PlaceholderPage() {
  return <section className="si-placeholder"><h1>页面不存在</h1><p>请检查地址，或返回项目中心。</p><Link to="/">返回项目中心</Link></section>;
}

export const route: RouteObject = { path: "*", element: <PlaceholderPage /> };
