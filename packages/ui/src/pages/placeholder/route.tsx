import { Link } from "react-router-dom";
import type { RouteObject } from "react-router-dom";
import { PageFrame, PageHeader } from "../../components";

function PlaceholderPage() {
  return <PageFrame kind="global" scroll="content" header={<PageHeader title="页面不存在" />}>
    <section className="si-placeholder"><p>请检查地址，或返回项目中心。</p><Link to="/">返回项目中心</Link></section>
  </PageFrame>;
}

export const route: RouteObject = { path: "*", element: <PlaceholderPage /> };
