import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { EdmCandidate, EdmCampaignSafetyFinding, EdmMediaGap } from "@siteindex/shared";
import { PENDING_HANDLERS } from "@siteindex/shared";
import { api, isMockApi } from "../../../api";
import { ApiErrorNotice, Chip, Input, Segmented } from "../../../components";
import "./scenario-sections.css";

type ScenarioTab = "candidates" | "mediaGaps" | "campaignSafety";

export function availableEdmScenarioTabs(): ScenarioTab[] {
  const methods = ["candidates", "mediaGaps", "campaignSafety"] as const;
  return methods.filter((method) => typeof api.edm[method] === "function"
    && (isMockApi || !PENDING_HANDLERS.includes(`edm.${method}`)));
}

const labels: Record<ScenarioTab, string> = {
  candidates: "候选清单", mediaGaps: "缺图清单", campaignSafety: "发送前安全检查",
};

const stockLabels = { in_stock: "有货", out_of_stock: "缺货", preorder: "预售", unknown: "未知" };

function CandidateRows({ rows }: { rows: EdmCandidate[] }) {
  return <ul className="si-edm-scenario-list">{rows.map((row) => <li key={row.sku}>
    <div><strong>{row.sku}</strong><span>{row.title}</span></div>
    <small>{stockLabels[row.stock_status]} · {row.category ?? "未分类"} · {row.image_source === "none" ? "缺图" : row.image_source === "manual" ? "手动首图" : "抓取首图"}{row.exclude_edm ? " · 已排除 EDM" : ""}</small>
  </li>)}</ul>;
}

function GapRows({ rows }: { rows: EdmMediaGap[] }) {
  return <ul className="si-edm-scenario-list">{rows.map((row) => <li key={row.sku}>
    <div><strong>{row.sku}</strong><span>{row.title}</span></div>
    <small>{row.reason === "webp_only" ? "仅有不兼容的图片格式" : "没有图片来源"} · {stockLabels[row.stock_status]}</small>
  </li>)}</ul>;
}

function FindingRows({ findings }: { findings: EdmCampaignSafetyFinding[] }) {
  return <ul className="si-edm-scenario-list">{findings.map((finding, index) => <li key={`${finding.code}:${finding.sku ?? ""}:${index}`}>
    <div><Chip tone={finding.severity === "blocker" ? "danger" : "warn"}>{finding.severity === "blocker" ? "阻断" : "提醒"}</Chip><strong>{finding.sku ?? "活动"}</strong></div>
    <small>{finding.message}</small>
  </li>)}</ul>;
}

function Candidates({ projectId }: { projectId: string }) {
  const query = useQuery({ queryKey: ["edm", "scenario", "candidates", projectId], queryFn: () => api.edm.candidates!(projectId, { limit: 50 }) });
  if (query.isLoading) return <p role="status">正在加载候选清单…</p>;
  if (query.isError) return <ApiErrorNotice label="候选清单加载失败。" error={query.error} onRetry={() => void query.refetch()} />;
  const data = query.data?.data;
  if (!data?.rows.length) return <p>暂无符合条件的候选 SKU。</p>;
  return <><p>共 {data.total} 个候选 SKU；这里展示前 {data.rows.length} 个，按 SKU 顺序排列，不代表推荐排名。</p><CandidateRows rows={data.rows} /></>;
}

function MediaGaps({ projectId }: { projectId: string }) {
  const query = useQuery({ queryKey: ["edm", "scenario", "mediaGaps", projectId], queryFn: () => api.edm.mediaGaps!(projectId, { limit: 50 }) });
  if (query.isLoading) return <p role="status">正在加载缺图清单…</p>;
  if (query.isError) return <ApiErrorNotice label="缺图清单加载失败。" error={query.error} onRetry={() => void query.refetch()} />;
  const data = query.data?.data;
  if (!data?.rows.length) return <p>当前没有缺少 EDM 兼容图片的 SKU。</p>;
  return <><p>共 {data.total} 个缺图 SKU；这里展示前 {data.rows.length} 个。</p><GapRows rows={data.rows} /></>;
}

function localDate(): string {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function CampaignSafety({ projectId, skus }: { projectId: string; skus: string[] }) {
  const [campaignDate, setCampaignDate] = useState(localDate);
  const query = useQuery({
    queryKey: ["edm", "scenario", "campaignSafety", projectId, campaignDate, skus],
    queryFn: () => api.edm.campaignSafety!(projectId, { campaign_date: campaignDate, skus }),
    enabled: skus.length > 0 && Boolean(campaignDate),
  });
  return <div className="si-edm-scenario-safety">
    <label>活动日期 <Input type="date" aria-label="活动日期" value={campaignDate} onChange={(event) => setCampaignDate(event.target.value)} /></label>
    <p>检查当前表格选中的 {skus.length} 个 SKU；只核对本地产品数据，不检查邮件、受众或发送平台。</p>
    {skus.length === 0 || !campaignDate ? <p>请先在图片表勾选 SKU 并选择活动日期。</p>
      : query.isLoading ? <p role="status">正在检查所选 SKU…</p>
        : query.isError ? <ApiErrorNotice label="发送前安全检查失败。" error={query.error} onRetry={() => void query.refetch()} />
          : query.data?.data ? <>
            <Chip tone={query.data.data.status === "clear" ? "ok" : query.data.data.status === "blocked" ? "danger" : "warn"}>{query.data.data.status === "clear" ? "本地数据通过" : query.data.data.status === "blocked" ? "存在阻断项" : "需要人工复核"}</Chip>
            {query.data.data.findings.length ? <FindingRows findings={query.data.data.findings} /> : <p>未发现本地产品数据问题。</p>}
          </> : <p>暂无可用检查结果。</p>}
  </div>;
}

export function EdmScenarioSections({ projectId, selectedSkus }: { projectId: string; selectedSkus: string[] }) {
  const available = availableEdmScenarioTabs();
  const [tab, setTab] = useState<ScenarioTab>(available[0] ?? "candidates");
  const active = available.includes(tab) ? tab : available[0];
  if (!active) return null;
  return <div className="si-edm-scenario-sections">
    <Segmented value={active} options={available.map((value) => ({ value, label: labels[value] }))} onChange={setTab} ariaLabel="EDM 只读检查分段" />
    {active === "candidates" ? <Candidates projectId={projectId} /> : active === "mediaGaps" ? <MediaGaps projectId={projectId} /> : <CampaignSafety projectId={projectId} skus={selectedSkus} />}
  </div>;
}
