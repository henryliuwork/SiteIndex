import { useState } from "react";
import { Link } from "react-router-dom";
import type { BlogPost, ContentSummary, DesignTokens, PageResult, RunLog } from "@siteindex/shared";
import { ApiErrorNotice, formatDateTime } from "../../components";
import { Metric, Module, type ModuleQuery } from "./core-modules";

function calendarDay(date: Date): string {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
}

export function recentBlogCount(posts: BlogPost[], now = new Date()): number {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
  const first = calendarDay(start);
  const last = calendarDay(now);
  return posts.filter(({ published_at }) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(published_at)) return false;
    const date = new Date(`${published_at}T12:00:00`);
    return !Number.isNaN(date.getTime()) && calendarDay(date) === published_at && published_at >= first && published_at <= last;
  }).length;
}

export function ContentModule({ id, summaryQuery, blogsQuery, coreKeywords }: {
  id: string; summaryQuery: ModuleQuery<ContentSummary>; blogsQuery: ModuleQuery<PageResult<BlogPost>>;
  coreKeywords: string[] | undefined;
}) {
  const to = `/p/${encodeURIComponent(id)}/content`;
  const posts = blogsQuery.data;
  const uncovered = summaryQuery.data?.uncovered_core_keywords;
  const configured = [...new Set(coreKeywords?.map((keyword) => keyword.trim().toLowerCase()).filter(Boolean) ?? [])];
  const covered = configured.length && uncovered ? Math.max(0, configured.length - uncovered.filter((keyword) => configured.includes(keyword.trim().toLowerCase())).length) : null;
  return <Module title="内容" to={to}>
    {summaryQuery.isPending || blogsQuery.isPending ? <p role="status">正在加载内容摘要…</p>
      : summaryQuery.isError || blogsQuery.isError ? <ApiErrorNotice label="内容摘要加载失败。" error={summaryQuery.error ?? blogsQuery.error} onRetry={() => { void summaryQuery.refetch(); void blogsQuery.refetch(); }} />
        : !posts ? <p className="si-overview-module-empty">尚无博客索引，请运行每周抓取。</p>
          : <>
            <div className="si-overview-module-metrics">
              <Metric label="博客文章" value={String(posts.total)} to={to} />
              <Metric label="近 7 天新增" value={String(recentBlogCount(posts.rows))} to={to} />
              <Metric label="核心词覆盖" value={covered === null ? "—" : `${covered}/${configured.length}`} />
            </div>
            {!configured.length && <p className="si-overview-module-hint">尚未配置核心关键词。</p>}
            {!posts.total && <p className="si-overview-module-empty">尚无博客文章，请运行每周抓取。</p>}
          </>}
  </Module>;
}

type DesignResult = { tokens: DesignTokens | null };
export function DesignModule({ id, query, onCopy }: {
  id: string; query: ModuleQuery<DesignResult>; onCopy: (hex: string) => void;
}) {
  const colors = query.data?.tokens?.color;
  const roles = [
    { label: "主色", value: colors?.primary },
    { label: "辅助色", value: colors?.secondary },
    { label: "正文色", value: colors?.text },
  ];
  return <Module title="网站主色" to={`/p/${encodeURIComponent(id)}/design`}>
    {query.isPending ? <p role="status">正在加载网站配色…</p>
      : query.isError ? <ApiErrorNotice label="网站配色加载失败。" error={query.error} onRetry={() => void query.refetch()} />
        : !colors || roles.every(({ value }) => !value) ? <p className="si-overview-module-empty">尚无设计规范，请提取站点设计规范。</p>
          : <div className="si-overview-colors">{roles.map(({ label, value }) => {
            const hex = value && /^#[\da-f]{3}(?:[\da-f]{3})?$/i.test(value) ? value.toUpperCase() : null;
            return <div className="si-overview-color" key={label}><span>{label}</span>
              {hex ? <button type="button" onClick={() => onCopy(hex)} aria-label={`复制${label} ${hex}`}>
                <span className="si-overview-swatch" style={{ backgroundColor: hex }} aria-hidden="true" /><code>{hex}</code>
              </button> : <strong>—</strong>}
            </div>;
          })}</div>}
  </Module>;
}

const jobNames: Record<RunLog["job"], string> = {
  daily: "每日同步", weekly: "每周同步", monthly: "每月同步", validate: "数据校验", readme: "刷新 README",
  design: "提取设计规范", "index-check": "检查收录", views: "重建视图", init: "项目初始化", media: "图片 URL 处理",
};
const statusNames: Record<RunLog["status"], string> = { ok: "成功", partial: "部分完成", failed: "失败", skipped: "已跳过" };

function duration(run: RunLog): string {
  if (!run.finished_at) return "—";
  const seconds = Math.round((Date.parse(run.finished_at) - Date.parse(run.started_at)) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

export function JobsModule({ id, query }: { id: string; query: ModuleQuery<RunLog[]> }) {
  const to = `/p/${encodeURIComponent(id)}/runs`;
  const [showAll, setShowAll] = useState(false);
  const runs = query.data?.slice(0, 5) ?? [];
  const row = (run: RunLog) => <li key={run.run_id} className={run.status === "failed" ? "is-failed" : undefined}>
    <Link to={`${to}?run=${encodeURIComponent(run.run_id)}`}>
      <strong>{jobNames[run.job] ?? run.job}</strong><span>{statusNames[run.status]}</span>
      <time dateTime={run.started_at}>{formatDateTime(run.started_at)}</time><small>{duration(run)}</small>
    </Link>
  </li>;
  return <Module title="最近抓取任务记录" to={to}>
    {query.isPending ? <p role="status">正在加载运行记录…</p>
      : query.isError ? <ApiErrorNotice label="运行记录加载失败。" error={query.error} onRetry={() => void query.refetch()} />
        : !runs.length ? <p className="si-overview-module-empty">暂无运行记录，可在运行页启动任务。</p>
          : <><ul className="si-overview-jobs">{row(runs[0]!)}{showAll && runs.slice(1).map(row)}</ul>
            {runs.length > 1 && <button type="button" className="si-overview-jobs-toggle" aria-expanded={showAll}
              onClick={() => setShowAll((current) => !current)}>{showAll ? "收起任务记录" : `查看其余 ${runs.length - 1} 条`}</button>}</>}
  </Module>;
}
