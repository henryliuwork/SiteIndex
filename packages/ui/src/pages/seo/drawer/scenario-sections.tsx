import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { PENDING_HANDLERS, SEO_RULE_LABELS, type SeoIssue, type SiteIndexApi } from "@siteindex/shared";
import { api, isMockApi } from "../../../api";
import { ApiErrorNotice, EmptyState, Segmented, formatDateTime } from "../../../components";
import "./scenario-sections.css";

type ScenarioTab = "overview" | "brief" | "issues" | "links";
const pageTypes = { home: "首页", collection: "分类", product: "产品", blog: "博客", page: "页面", other: "其他" } as const;

export function seoScenarioTabs(
  seo: SiteIndexApi["seo"],
  mock: boolean,
  pending: readonly string[] = PENDING_HANDLERS,
): ScenarioTab[] {
  const available = (method: "pageBrief" | "issueCandidates" | "internalLinkContext") =>
    typeof seo[method] === "function" && (mock || !pending.includes(`seo.${method}`));
  return ["overview", ...(available("pageBrief") ? ["brief"] : []),
    ...(available("issueCandidates") ? ["issues"] : []),
    ...(available("internalLinkContext") ? ["links"] : [])] as ScenarioTab[];
}

function QueryState({ loading, error, data, onRetry, empty, children }: {
  loading: boolean; error: unknown; data: unknown; onRetry: () => void; empty: string; children: ReactNode;
}) {
  if (loading) return <div className="si-query-loading" role="status">正在加载查询结果…</div>;
  if (error) return <ApiErrorNotice label="查询失败。" error={error} onRetry={onRetry} />;
  if (data == null) return <EmptyState>{empty}</EmptyState>;
  return <>{children}</>;
}

function Brief({ id, url }: { id: string; url: string }) {
  const query = useQuery({ queryKey: ["seo", "pageBrief", id, url], queryFn: () => api.seo.pageBrief!(id, url) });
  const result = query.data;
  return <QueryState loading={query.isLoading} error={query.error} data={result?.data} onRetry={() => void query.refetch()} empty="没有这张页面的简报。">
    {result?.data && <div className="si-seo-scenario">
      <strong>{result.data.page.title || "未设置标题"}</strong>
      <span className="si-seo-scenario-url">{result.data.page.url}</span>
      <dl><div><dt>页面类型</dt><dd>{pageTypes[result.data.page.page_type]}</dd></div><div><dt>HTTP 状态</dt><dd>{result.data.page.status_code}</dd></div>
        <div><dt>相关问题</dt><dd>{result.data.issues.length} 条</dd></div><div><dt>入链 / 出链</dt><dd>{result.data.incoming_links.length} / {result.data.outgoing_links.length}</dd></div></dl>
      {result.metadata.collected_at && <small>数据采集于 {formatDateTime(result.metadata.collected_at)}</small>}
    </div>}
  </QueryState>;
}

function IssueRow({ issue }: { issue: SeoIssue }) {
  return <li><strong>{SEO_RULE_LABELS[issue.rule] ?? issue.rule}</strong><span>{issue.detail}</span><small>{issue.severity === "high" ? "高" : issue.severity === "mid" ? "中" : "低"} · {issue.status === "open" ? "待处理" : issue.status === "fixed" ? "已处理" : "已忽略"}</small></li>;
}

function IssueCandidates({ id, url }: { id: string; url: string }) {
  const query = useQuery({ queryKey: ["seo", "issueCandidates", id, url], queryFn: () => api.seo.issueCandidates!(id, url) });
  const issues = query.data?.data;
  return <QueryState loading={query.isLoading} error={query.error} data={issues} onRetry={() => void query.refetch()} empty="没有可用的问题候选数据。">
    {issues?.length ? <ul className="si-seo-scenario-list">{issues.map((issue) => <IssueRow key={`${issue.url}:${issue.rule}`} issue={issue} />)}</ul>
      : <EmptyState>这张页面没有问题候选。</EmptyState>}
  </QueryState>;
}

function LinkContext({ id, url }: { id: string; url: string }) {
  const query = useQuery({ queryKey: ["seo", "internalLinkContext", id, url], queryFn: () => api.seo.internalLinkContext!(id, url) });
  const context = query.data?.data;
  return <QueryState loading={query.isLoading} error={query.error} data={context} onRetry={() => void query.refetch()} empty="没有可用的内链上下文。">
    {context && <div className="si-seo-scenario">
      <section><h4>入链 {context.incoming_links.length} 条</h4>{context.incoming_links.length ? <ul className="si-seo-scenario-list">{context.incoming_links.map(({ link, source_page }, index) =>
        <li key={`${link.from}:${index}`}><strong>{source_page?.title || link.from}</strong><span className="si-seo-scenario-url">{link.from}</span><small>锚文本：{link.anchor || "（空）"}</small></li>)}</ul> : <EmptyState>没有入链。</EmptyState>}</section>
      <section><h4>出链 {context.outgoing_links.length} 条</h4>{context.outgoing_links.length ? <ul className="si-seo-scenario-list">{context.outgoing_links.map(({ link, target_page }, index) =>
        <li key={`${link.to}:${index}`}><strong>{target_page?.title || link.to}</strong><span className="si-seo-scenario-url">{link.to}</span><small>锚文本：{link.anchor || "（空）"}</small></li>)}</ul> : <EmptyState>没有出链。</EmptyState>}</section>
    </div>}
  </QueryState>;
}

export function SeoScenarioSections({ id, url, overview }: { id: string; url: string; overview: ReactNode }) {
  const tabs = seoScenarioTabs(api.seo, Boolean(isMockApi));
  const [tab, setTab] = useState<ScenarioTab>("overview");
  if (tabs.length === 1) return <>{overview}</>;
  const labels: Record<ScenarioTab, string> = { overview: "概况", brief: "页面简报", issues: "问题候选", links: "内链上下文" };
  return <div className="si-seo-scenario-sections">
    <Segmented value={tab} options={tabs.map((value) => ({ value, label: labels[value] }))} onChange={setTab} ariaLabel="页面详情分段" />
    {tab === "overview" ? overview : tab === "brief" ? <Brief id={id} url={url} /> : tab === "issues" ? <IssueCandidates id={id} url={url} /> : <LinkContext id={id} url={url} />}
  </div>;
}
