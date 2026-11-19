import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { PENDING_HANDLERS, SEO_RULE_LABELS, type SeoIssue, type SiteIndexApi } from "@siteindex/shared";
import { api, isMockApi } from "../../../api";
import { ApiErrorNotice, Button, EmptyState, Segmented } from "../../../components";
import "./scenario-sections.css";

type ScenarioTab = "index" | "issues" | "links";

export interface SeoDrawerIssueActions {
  markFixed?: (issue: SeoIssue) => void;
  ignoreIssue?: (issue: SeoIssue) => void;
  ignoreRule?: (issue: SeoIssue) => void;
  restore?: (issue: SeoIssue) => void;
}

function scenarioAvailable(seo: SiteIndexApi["seo"], mock: boolean, pending: readonly string[], method: "pageBrief" | "issueCandidates" | "internalLinkContext") {
  return typeof seo[method] === "function" && (mock || !pending.includes(`seo.${method}`));
}

export function seoScenarioTabs(
  seo: SiteIndexApi["seo"],
  mock: boolean,
  pending: readonly string[] = PENDING_HANDLERS,
): ScenarioTab[] {
  const available = (method: "pageBrief" | "issueCandidates" | "internalLinkContext") => scenarioAvailable(seo, mock, pending, method);
  return ["index", ...(available("pageBrief") || available("issueCandidates") ? ["issues"] : []),
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

function CandidateIssues({ id, url }: { id: string; url: string }) {
  const query = useQuery({ queryKey: ["seo", "issueCandidates", id, url], queryFn: () => api.seo.issueCandidates!(id, url) });
  return <QueryState loading={query.isLoading} error={query.error} data={query.data?.data} onRetry={() => void query.refetch()} empty="没有可用的问题候选数据。">
    {query.data?.data?.length ? <ul className="si-seo-scenario-list">{query.data.data.map((issue) =>
      <IssueRow key={`${issue.url}:${issue.rule}`} issue={issue} actions={{}} />)}</ul>
      : <EmptyState>这张页面没有待处理问题候选。</EmptyState>}
  </QueryState>;
}

function PageIssues({ id, url, actions, hasBrief, hasCandidates }: { id: string; url: string; actions: SeoDrawerIssueActions; hasBrief: boolean; hasCandidates: boolean }) {
  const [showCandidates, setShowCandidates] = useState(false);
  const query = useQuery({ queryKey: ["seo", "pageBrief", id, url], queryFn: () => api.seo.pageBrief!(id, url), enabled: hasBrief });
  const result = query.data;
  return <div className="si-seo-scenario">
    {hasBrief && <QueryState loading={query.isLoading} error={query.error} data={result?.data} onRetry={() => void query.refetch()} empty="没有这张页面的问题数据。">
      {result?.data?.issues.length ? <ul className="si-seo-scenario-list">{result.data.issues.map((issue) =>
      <IssueRow key={`${issue.url}:${issue.rule}`} issue={issue} actions={actions} />)}</ul>
        : <EmptyState>这张页面没有 SEO 问题。</EmptyState>}
    </QueryState>}
    {hasCandidates && <section><Button size="small" variant="quiet" aria-expanded={showCandidates} onClick={() => setShowCandidates((value) => !value)}>待处理问题候选</Button>
      {showCandidates && <CandidateIssues id={id} url={url} />}</section>}
  </div>;
}

function IssueRow({ issue, actions }: { issue: SeoIssue; actions: SeoDrawerIssueActions }) {
  return <li><strong>{SEO_RULE_LABELS[issue.rule] ?? issue.rule}</strong><span>{issue.detail}</span>
    <small>{issue.severity === "high" ? "高" : issue.severity === "mid" ? "中" : "低"} · {issue.status === "open" ? "待处理" : issue.status === "fixed" ? "已处理" : "已忽略"}</small>
    {issue.status === "open" ? <div className="si-seo-scenario-actions">
      {actions.markFixed && <Button size="small" onClick={() => actions.markFixed?.(issue)}>标记已处理</Button>}
      {actions.ignoreIssue && <Button size="small" onClick={() => actions.ignoreIssue?.(issue)}>忽略此页面此问题</Button>}
      {actions.ignoreRule && <Button size="small" onClick={() => actions.ignoreRule?.(issue)}>忽略此类问题</Button>}
    </div> : actions.restore && <div className="si-seo-scenario-actions"><Button size="small" onClick={() => actions.restore?.(issue)}>恢复为待处理</Button></div>}
  </li>;
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

export function SeoScenarioSections({ id, url, overview, issueActions = {} }: { id: string; url: string; overview: ReactNode; issueActions?: SeoDrawerIssueActions }) {
  const mock = Boolean(isMockApi);
  const tabs = seoScenarioTabs(api.seo, mock);
  const hasBrief = scenarioAvailable(api.seo, mock, PENDING_HANDLERS, "pageBrief");
  const hasCandidates = scenarioAvailable(api.seo, mock, PENDING_HANDLERS, "issueCandidates");
  const [tab, setTab] = useState<ScenarioTab>("index");
  if (tabs.length === 1) return <>{overview}</>;
  const labels: Record<ScenarioTab, string> = { index: "收录", issues: "问题", links: "内链" };
  return <div className="si-seo-scenario-sections">
    <Segmented value={tab} options={tabs.map((value) => ({ value, label: labels[value] }))} onChange={setTab} ariaLabel="页面详情分段" />
    {tab === "index" ? overview : tab === "issues" ? <PageIssues id={id} url={url} actions={issueActions} hasBrief={hasBrief} hasCandidates={hasCandidates} /> : <LinkContext id={id} url={url} />}
  </div>;
}
