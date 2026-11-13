import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { GscAuthorizationStatus, GscSyncMode, GscSyncResult, SiteIndexApi } from "@siteindex/shared";
import { ApiErrorNotice, Button, Chip, EmptyState, Notice, Select, useToast } from "../../components";

type GscApi = NonNullable<SiteIndexApi["gsc"]>;
type GscAction = "connect" | "disconnect" | "select" | "sync";

const gscStatusKey = ["gsc-authorization-status"] as const;
const gscPropertiesKey = (projectId: string) => ["gsc-properties", projectId] as const;

function isCompleteGscApi(value: SiteIndexApi["gsc"]): value is GscApi {
  return Boolean(value
    && typeof value.status === "function"
    && typeof value.connect === "function"
    && typeof value.disconnect === "function"
    && typeof value.listProperties === "function"
    && typeof value.selectProperty === "function"
    && typeof value.sync === "function");
}

function statusLabel(status: GscAuthorizationStatus["state"] | undefined): string {
  switch (status) {
    case "not_configured": return "尚未配置";
    case "disconnected": return "未连接";
    case "connected": return "已连接";
    case "reauthorization_required": return "需要重新授权";
    case "unavailable": return "当前不可用";
    default: return "正在读取连接状态";
  }
}

function reasonLabel(status: GscAuthorizationStatus): string | null {
  switch (status.reason) {
    case "client_id_missing": return "当前桌面版本尚未配置 Google OAuth 客户端。";
    case "encryption_unavailable": return "此设备无法安全保存授权凭据。";
    case "credentials_unreadable": return "本机授权凭据无法读取，请重新连接。";
    case "refresh_token_rejected": return "Google 授权已失效，请重新连接。";
    default:
      if (status.state === "unavailable") return "Search Console 服务当前不可用。";
      if (status.state === "not_configured") return "连接能力尚未配置。";
      if (status.state === "reauthorization_required") return "需要重新授权后才能继续。";
      return null;
  }
}

function permissionLabel(permission: string): string {
  switch (permission) {
    case "siteOwner": return "所有者";
    case "siteFullUser": return "完全用户";
    case "siteRestrictedUser": return "受限用户";
    case "siteUnverifiedUser": return "未验证用户";
    default: return permission || "权限未知";
  }
}

function syncStateLabel(result: GscSyncResult): string {
  switch (result.state) {
    case "complete": return "已完成";
    case "partial": return "部分完成";
    case "blocked": return "已阻止";
    case "failed": return "失败";
  }
}

function syncStateTone(result: GscSyncResult): "ok" | "warn" | "danger" {
  if (result.state === "complete") return "ok";
  if (result.state === "partial") return "warn";
  return "danger";
}

function modeLabel(mode: GscSyncMode): string {
  return mode === "initial_90_days" ? "首次同步最近 90 天" : "增量同步";
}

function missingRangeLabel(reason: string): string {
  switch (reason) {
    case "no_rows": return "该日期范围没有数据";
    case "not_yet_available": return "Search Console 尚未提供该日期的数据";
    case "not_returned": return "该日期范围未返回";
    default: return "该日期范围缺少数据";
  }
}

export function GscSettingsCard({
  projectId,
  gsc,
  isDemo = false,
  onPropertySelectionChange,
}: {
  projectId: string;
  gsc?: SiteIndexApi["gsc"];
  isDemo?: boolean;
  onPropertySelectionChange?: (siteUrl: string | null) => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const available = isCompleteGscApi(gsc);
  const [busyAction, setBusyAction] = useState<GscAction | null>(null);
  const [operationError, setOperationError] = useState<{ label: string; error: unknown } | null>(null);
  const [syncMode, setSyncMode] = useState<GscSyncMode | "">("");
  const [syncResult, setSyncResult] = useState<GscSyncResult | null>(null);
  const statusQuery = useQuery({
    queryKey: gscStatusKey,
    queryFn: () => gsc!.status(),
    enabled: available,
    retry: false,
  });
  const propertiesQuery = useQuery({
    queryKey: gscPropertiesKey(projectId),
    queryFn: () => gsc!.listProperties(projectId),
    enabled: available && statusQuery.data?.state === "connected",
    retry: false,
  });

  const status = statusQuery.data;
  const propertyResult = propertiesQuery.data;
  const propertyData = propertyResult?.data ?? null;
  const selectedSiteUrl = propertyData?.selected_site_url ?? null;
  const selectedPropertyExists = Boolean(selectedSiteUrl && propertyData?.properties.some(({ site_url }) => site_url === selectedSiteUrl));

  const updateStatus = async (next: GscAuthorizationStatus) => {
    queryClient.setQueryData(gscStatusKey, next);
    if (next.state === "connected") {
      await queryClient.invalidateQueries({ queryKey: gscPropertiesKey(projectId) });
    } else {
      queryClient.removeQueries({ queryKey: gscPropertiesKey(projectId) });
    }
  };

  const runConnectionAction = async (action: "connect" | "disconnect") => {
    if (!available || busyAction) return;
    setBusyAction(action);
    setOperationError(null);
    try {
      const next = action === "connect" ? await gsc.connect() : await gsc.disconnect();
      await updateStatus(next);
      if (next.state === "connected") toast.success(isDemo ? "演示连接已完成。" : "Search Console 已连接。");
      else if (action === "disconnect" && next.state === "disconnected") toast.success("Search Console 已断开。");
    } catch (error) {
      setOperationError({ label: action === "connect" ? "无法连接 Search Console" : "无法断开 Search Console", error });
    } finally {
      setBusyAction(null);
    }
  };

  const selectProperty = async (siteUrl: string | null) => {
    if (!available || busyAction) return;
    setBusyAction("select");
    setOperationError(null);
    try {
      const selection = await gsc.selectProperty(projectId, siteUrl);
      queryClient.setQueryData(gscPropertiesKey(projectId), (current: typeof propertyResult | undefined) => current?.data
        ? { ...current, data: { ...current.data, selected_site_url: selection.site_url } }
        : current);
      onPropertySelectionChange?.(selection.site_url);
      toast.success(selection.site_url ? "Search Console 属性选择已保存。" : "已清除 Search Console 属性选择。");
    } catch (error) {
      setOperationError({ label: "无法保存属性选择", error });
    } finally {
      setBusyAction(null);
    }
  };

  const sync = async () => {
    if (!available || !selectedSiteUrl || !syncMode || busyAction) return;
    setBusyAction("sync");
    setOperationError(null);
    setSyncResult(null);
    try {
      const result = await gsc.sync(projectId, { mode: syncMode });
      setSyncResult(result);
      if (result.state === "complete") toast.success("Search Console 同步已完成。");
      else if (result.state === "partial") toast.info("Search Console 同步部分完成，请查看本次结果。");
      else toast.error("Search Console 同步未完成，请查看错误信息。");
    } catch (error) {
      setOperationError({ label: "Search Console 同步请求失败", error });
    } finally {
      setBusyAction(null);
    }
  };

  const propertyOptions = [
    ...(selectedSiteUrl && !selectedPropertyExists ? [{ value: selectedSiteUrl, label: `${selectedSiteUrl} · 当前已保存` }] : []),
    ...(selectedSiteUrl ? [{ value: "__clear_selection__", label: "清除当前属性选择" }] : []),
    ...(propertyData?.properties ?? []).map((property) => ({
      value: property.site_url,
      label: `${property.site_url} · ${permissionLabel(property.permission_level)}`,
    })),
  ];

  return <section className="si-gsc-settings" aria-labelledby="si-gsc-settings-heading">
    <div className="si-gsc-heading">
      <div>
        <h3 id="si-gsc-settings-heading">Google Search Console</h3>
        <p>只读读取所选属性的数据，不会修改 Google Search Console 中的内容，也不会显示授权令牌或账号邮箱。</p>
      </div>
      {isDemo && <Chip tone="info">虚构演示数据</Chip>}
    </div>

    {isDemo && <Notice tone="info" title="演示模式">
      当前使用 <code>demo.example.test</code> 虚构属性和合成同步结果；不会连接 Google。安装版的真实授权需要 Desktop bridge 接线。
    </Notice>}

    {!available ? <Notice tone="warn" title="当前 Desktop bridge 尚未接入 Search Console">
      此 bridge 未提供完整的 GSC 方法。本卡片保持只读提示状态，不影响本页其他项目设置；接线完成后可在这里连接、选择属性并查看同步结果。
    </Notice> : <>
      <div className="si-gsc-status-row">
        <span>本机连接状态</span>
        <Chip tone={status?.state === "connected" ? "ok" : status?.state === "reauthorization_required" || status?.state === "unavailable" ? "warn" : "neutral"}>
          {statusQuery.isError ? "状态读取失败" : statusLabel(status?.state)}
        </Chip>
        {status?.reason && <small>{reasonLabel(status)}</small>}
        <div className="si-gsc-actions">
          {status?.state === "connected"
            ? <Button size="small" disabled={Boolean(busyAction)} onClick={() => void runConnectionAction("disconnect")}>{busyAction === "disconnect" ? "断开中…" : isDemo ? "断开演示连接" : "断开连接"}</Button>
            : <Button size="small" variant="primary" disabled={Boolean(busyAction) || statusQuery.isError || statusQuery.isPending} onClick={() => void runConnectionAction("connect")}>{busyAction === "connect" ? "连接中…" : status?.state === "reauthorization_required" ? "重新授权" : isDemo ? "模拟连接" : "连接 Search Console"}</Button>}
        </div>
      </div>

      {statusQuery.isError && <ApiErrorNotice label="无法读取 Search Console 连接状态" error={statusQuery.error} detail="请检查 Desktop bridge 是否已接线，然后重试。" onRetry={() => { void statusQuery.refetch(); }} />}
      {operationError && <ApiErrorNotice label={operationError.label} error={operationError.error} detail="本次操作未确认成功；可检查连接状态后再尝试。" />}

      {status?.state === "connected" && <div className="si-gsc-connected-content">
        {propertiesQuery.isError && <ApiErrorNotice label="无法读取 Search Console 属性" error={propertiesQuery.error} detail="没有更改当前属性选择。" onRetry={() => { void propertiesQuery.refetch(); }} />}
        {propertiesQuery.isPending && <p className="si-gsc-inline-status" role="status">正在读取可访问的属性…</p>}
        {propertyResult && propertyResult.metadata.quality !== "complete" && <Notice tone={propertyResult.metadata.quality === "unreliable" ? "error" : "warn"} title="属性列表数据不完整">
          {propertyResult.metadata.anomalies.length > 0
            ? "请同时检查下方数据提示，再确认属性选择。"
            : `当前数据质量为${propertyResult.metadata.quality === "partial" ? "部分" : "不可靠"}；请重新读取后确认属性选择。`}
        </Notice>}
        {propertyResult?.metadata.anomalies.map((anomaly) => <Notice key={`${anomaly.code}-${anomaly.field ?? ""}`} tone={anomaly.severity === "unreliable" ? "error" : "warn"} title="属性列表数据提示">{anomaly.message}</Notice>)}
        {!propertiesQuery.isPending && !propertiesQuery.isError && !propertyData && <EmptyState title="属性列表暂不可用" action={<Button size="small" onClick={() => void propertiesQuery.refetch()}>重新读取属性</Button>}>
          当前没有可用属性数据。这不会修改当前项目配置。
        </EmptyState>}
        {propertyData && <>
          <div className="si-gsc-property-row">
            <label className="si-config-field"><span>当前项目的 Search Console 属性</span>
              <Select
                ariaLabel="Search Console 属性"
                value={selectedSiteUrl ?? ""}
                placeholder="请选择一个属性"
                disabled={Boolean(busyAction) || propertiesQuery.isFetching}
                options={propertyOptions}
                onValueChange={(value) => void selectProperty(value === "__clear_selection__" ? null : value)}
              />
            </label>
            <p>需要明确选择一个属性后才能同步。属性选择按项目保存；同步只读取数据。</p>
            {selectedSiteUrl && !selectedPropertyExists && <Notice tone="warn">当前已保存的属性不在刚读取的列表中；请重新选择可访问属性或清除选择。</Notice>}
          </div>

          <div className="si-gsc-sync-row">
            <label className="si-config-field"><span>同步方式</span>
              <Select
                ariaLabel="GSC 同步方式"
                value={syncMode}
                placeholder="选择同步范围"
                disabled={Boolean(busyAction)}
                options={[
                  { value: "initial_90_days", label: "首次导入：最近 90 天可用数据" },
                  { value: "incremental", label: "增量同步：继续合并新日期" },
                ]}
                onValueChange={(value) => setSyncMode(value === "initial_90_days" || value === "incremental" ? value : "")}
              />
            </label>
            <Button variant="primary" disabled={!selectedPropertyExists || !syncMode || Boolean(busyAction)} onClick={() => void sync()}>
              {busyAction === "sync" ? "同步中…" : isDemo ? "运行演示同步" : "开始只读同步"}
            </Button>
          </div>
          {!selectedSiteUrl && <p className="si-gsc-inline-status">尚未选择属性；不会自动选取列表中的第一项。</p>}
          {syncResult && <div className="si-gsc-sync-result" role="status" aria-label="本次同步结果">
            <div className="si-gsc-sync-result-heading"><strong>本次操作结果</strong><Chip tone={syncStateTone(syncResult)}>{syncStateLabel(syncResult)}</Chip></div>
            <p>{modeLabel(syncResult.mode)}；收到 {syncResult.records_received.toLocaleString("zh-CN")} 条，写入 {syncResult.records_written.toLocaleString("zh-CN")} 条。</p>
            <p>{syncResult.history_effect === "merged" ? "本次结果已合并到对应日期。" : "本次失败，已有历史数据保持不变。"}</p>
            <dl>
              <div><dt>属性</dt><dd>{syncResult.metadata.property_site_url ?? "未返回"}</dd></div>
              <div><dt>数据截止</dt><dd>{syncResult.metadata.data_through ?? "未返回业务日期"}</dd></div>
              <div><dt>采集时间</dt><dd>{syncResult.metadata.collected_at ?? "未完成采集"}</dd></div>
            </dl>
            {"error" in syncResult && <Notice tone="error" title={`同步错误：${syncResult.error.code}`}>{syncResult.error.message}</Notice>}
            {syncResult.metadata.missing_ranges.length > 0 && <div className="si-gsc-sync-detail">
              <strong>缺失日期范围</strong>
              <ul>{syncResult.metadata.missing_ranges.map((range) => <li key={`${range.start_date}-${range.end_date}-${range.reason}`}>
                {range.start_date} 至 {range.end_date}：{missingRangeLabel(range.reason)}
              </li>)}</ul>
            </div>}
            {syncResult.metadata.missing_fields.length > 0 && <p>未返回字段：{syncResult.metadata.missing_fields.join("、")}</p>}
            {syncResult.metadata.anomalies.map((anomaly) => <Notice key={`${anomaly.code}-${anomaly.field ?? ""}`} tone={anomaly.severity === "unreliable" ? "error" : "warn"} title={anomaly.code}>{anomaly.message}</Notice>)}
            <small>这里仅保留本次页面操作的返回结果。当前契约没有读取已保存同步历史状态的方法，离开页面后不会在此恢复最近一次结果。</small>
          </div>}
        </>}
      </div>}
    </>}
  </section>;
}
