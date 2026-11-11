import { useMemo, useState, type FormEvent } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ProjectSummary, SiteConfig } from "@siteindex/shared";
import { api, apiErrorDetails, apiErrorMessage, isMockApi } from "../../api";
import { ApiErrorNotice, Button, Card, Chip, ConfirmDialog, Drawer, EmptyState, Notice, useToast } from "../../components";

type CredentialState = "configured" | "not_configured" | "needs_reentry" | "unavailable";
interface CredentialBridge {
  status?: (siteUrl: string) => Promise<{ state: CredentialState }>;
  save?: (input: { siteUrl: string; username: string; applicationPassword: string }) => Promise<void>;
  clear?: (siteUrl: string) => Promise<void>;
}
interface SiteIndexWindowBridge { wordpressCredentials?: CredentialBridge }
interface WordPressTarget { origin: string; projects: string[] }
interface WordPressTargets { targets: WordPressTarget[]; unreadable: number; insecure: string[] }

function getCredentialBridge(): CredentialBridge | undefined {
  return (window as Window & { siteindexWindow?: SiteIndexWindowBridge }).siteindexWindow?.wordpressCredentials;
}

async function loadTargets(): Promise<WordPressTargets> {
  const projects = await api.projects.list();
  const details = await Promise.all(projects.map(async (project) => {
    try { return { project, detail: await api.projects.get(project.id) }; }
    catch { return { project, detail: null }; }
  }));
  const targets = new Map<string, Set<string>>();
  const insecure: string[] = [];
  let unreadable = 0;
  for (const { project, detail } of details) {
    if (!detail) { unreadable += 1; continue; }
    const config: SiteConfig = detail.config;
    if (config.edm?.image_host?.type !== "wordpress") continue;
    try {
      const url = new URL(config.base_url);
      if (url.protocol !== "https:") { insecure.push(project.name); continue; }
      const origin = url.origin;
      const names = targets.get(origin) ?? new Set<string>();
      names.add(project.name);
      targets.set(origin, names);
    } catch {
      insecure.push(project.name);
    }
  }
  return {
    targets: [...targets].map(([origin, names]) => ({ origin, projects: [...names] })).sort((a, b) => a.origin.localeCompare(b.origin)),
    unreadable,
    insecure,
  };
}

function statusPresentation(state: CredentialState): { label: string; tone: "ok" | "warn" | "danger" | "neutral" } {
  switch (state) {
    case "configured": return { label: "本机凭据已保存", tone: "ok" };
    case "not_configured": return { label: "尚未配置", tone: "neutral" };
    case "needs_reentry": return { label: "需要重新录入", tone: "warn" };
    case "unavailable": return { label: "安全存储不可用", tone: "danger" };
  }
}

function errorMessage(error: unknown, fallback: string): string {
  const details = apiErrorDetails(error);
  return details ? details.message + (details.code ? `（${details.code}）` : "") : apiErrorMessage(error, fallback);
}

export function WordPressCredentialsCard() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const targetsQuery = useQuery({ queryKey: ["settings", "wordpress-targets"], queryFn: loadTargets, retry: false });
  const targets = targetsQuery.data?.targets ?? [];
  const bridge = getCredentialBridge();
  const bridgeReady = typeof bridge?.status === "function" && typeof bridge.save === "function" && typeof bridge.clear === "function";
  const statusQueries = useQueries({ queries: targets.map(({ origin }) => ({
    queryKey: ["settings", "wordpress-credential-status", origin],
    queryFn: () => bridge!.status!(origin),
    enabled: bridgeReady,
    retry: false,
  })) });
  const [editing, setEditing] = useState<WordPressTarget | null>(null);
  const [pendingDelete, setPendingDelete] = useState<WordPressTarget | null>(null);
  const [username, setUsername] = useState("");
  const [applicationPassword, setApplicationPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const editingState = useMemo(() => {
    if (!editing) return "not_configured" as const;
    const index = targets.findIndex((target) => target.origin === editing.origin);
    return statusQueries[index]?.data?.state ?? "not_configured";
  }, [editing, statusQueries, targets]);

  const closeEditor = () => {
    setEditing(null);
    setUsername("");
    setApplicationPassword("");
  };

  const refreshStatus = async (origin: string) => {
    await queryClient.invalidateQueries({ queryKey: ["settings", "wordpress-credential-status", origin] });
  };

  const saveCredentials = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editing || !bridge?.save || saving) return;
    const input = { siteUrl: editing.origin, username: username.trim(), applicationPassword };
    setSaving(true);
    try {
      await bridge.save(input);
      await refreshStatus(editing.origin);
      toast.success("本机凭据已保存。此状态不代表 WordPress 已验证或图片上传已启用。");
      closeEditor();
    } catch (error) {
      toast.error("保存本机凭据失败：" + errorMessage(error, "请稍后重试"));
    } finally {
      setUsername("");
      setApplicationPassword("");
      setSaving(false);
    }
  };

  const deleteCredentials = async () => {
    if (!pendingDelete || !bridge?.clear || deleting) return;
    const origin = pendingDelete.origin;
    setDeleting(true);
    try {
      await bridge.clear(origin);
      await refreshStatus(origin);
      toast.success("已删除该网站的本机凭据。");
    } catch (error) {
      toast.error("删除本机凭据失败：" + errorMessage(error, "请稍后重试"));
    } finally {
      setDeleting(false);
      setPendingDelete(null);
    }
  };

  return (
    <Card className="si-app-settings-card si-wp-credentials-card">
      <h2>WordPress 图片托管凭据</h2>
      {isMockApi && <Notice tone="info" title="浏览器 mock 模式">此表单仅用于界面演示；输入不会保存到本机或项目文件。</Notice>}
      <Notice tone="info" title="本机安全存储">
        凭据只保存在当前设备的加密存储中，不会写入项目文件或云盘。保存状态只表示本机有凭据，不会测试账号密码。
      </Notice>

      {targetsQuery.isLoading && <div role="status" className="si-wp-loading">正在检查 WordPress 图片托管项目…</div>}
      {targetsQuery.isError && <ApiErrorNotice label="WordPress 图片托管项目读取失败。" error={targetsQuery.error} onRetry={() => void targetsQuery.refetch()} />}
      {targetsQuery.data && targets.length === 0 && <EmptyState title="没有使用 WordPress 图片托管的项目">项目配置中将 EDM 图片托管设为 WordPress 后，可在这里管理本机凭据。</EmptyState>}
      {targetsQuery.data?.unreadable ? <Notice tone="warn" title="部分项目配置未能读取">{targetsQuery.data.unreadable} 个项目未能读取配置，因此没有检查其图片托管设置。</Notice> : null}
      {targetsQuery.data?.insecure.map((project) => <Notice key={project} tone="warn" title={`无法管理「${project}」的凭据`}>本机凭据管理仅支持 HTTPS 项目地址，请先检查项目配置。</Notice>)}

      {targets.map((target, index) => {
        const statusQuery = statusQueries[index];
        const state = bridgeReady ? statusQuery?.data?.state : undefined;
        const presentation = state ? statusPresentation(state) : null;
        const statusError = bridgeReady && statusQuery?.isError ? errorMessage(statusQuery.error, "状态读取失败。") : null;
        return (
          <section className="si-wp-credential-origin" key={target.origin} aria-label={`凭据：${target.origin}`}>
            <div className="si-wp-credential-origin-main">
              <div className="si-wp-credential-origin-copy">
                <strong>{target.origin}</strong>
                <small>关联项目：{target.projects.join("、")}</small>
              </div>
              <div className="si-wp-credential-origin-actions">
                {bridgeReady && statusQuery?.isLoading && <span role="status" className="si-setting-hint">正在读取状态…</span>}
                {presentation && <Chip tone={presentation.tone}>{presentation.label}</Chip>}
                {bridgeReady && state && state !== "unavailable" && <>
                  <Button size="small" onClick={() => { setUsername(""); setApplicationPassword(""); setEditing(target); }}>
                    {state === "configured" ? "替换凭据" : state === "needs_reentry" ? "重新录入" : "配置凭据"}
                  </Button>
                  {(state === "configured" || state === "needs_reentry") && <Button size="small" variant="danger" onClick={() => setPendingDelete(target)}>删除本机凭据</Button>}
                </>}
                {bridgeReady && statusQuery?.isError && <Button size="small" onClick={() => void statusQuery.refetch()}>重试</Button>}
                {bridgeReady && state === "unavailable" && <Button size="small" onClick={() => void statusQuery?.refetch()}>重新检查</Button>}
                {!bridgeReady && <Chip tone="warn">桌面接口不可用</Chip>}
              </div>
            </div>
            {statusError && <p className="si-setting-error si-wp-origin-error">读取凭据状态失败：{statusError}</p>}
            {!bridgeReady && <p className="si-setting-error si-wp-origin-error">当前桌面版本未提供完整的本机凭据管理接口，无法读取或管理此网站的凭据。请更新并重新启动 SiteIndex 后重试。</p>}
            {bridgeReady && state === "unavailable" && <p className="si-setting-error si-wp-origin-error">当前设备的本机安全存储不可用。请检查系统安全存储后重新检查。</p>}
          </section>
        );
      })}

      <Notice tone="warn" title="图片上传尚未开放">
        保存本机凭据不会启用图片上传。媒体准备任务尚未就绪，目前不能从 EDM 页面发起或替换 WordPress 媒体。
      </Notice>
      <Notice tone="info" title="旧配置与更换设备">
        软件不会读取、扫描或删除旧的 <code>.env</code> 文件。请在上方重新录入并确认“本机凭据已保存”后，再手动从旧配置中移除凭据。更换电脑后需要在新设备重新配置。
      </Notice>

      <Drawer
        open={Boolean(editing)}
        onOpenChange={(open) => { if (!open) closeEditor(); }}
        title={editingState === "configured" ? "替换 WordPress 凭据" : "配置 WordPress 凭据"}
        description={editing ? `${editing.origin} · 关联项目：${editing.projects.join("、")}` : undefined}
        width="standard"
        footer={<><Button onClick={closeEditor} disabled={saving}>取消</Button><Button variant="primary" type="submit" form="si-wp-credential-form" disabled={saving}>{saving ? "保存中…" : "保存到本机"}</Button></>}
      >
        <form id="si-wp-credential-form" className="si-wp-credential-form" onSubmit={(event) => void saveCredentials(event)}>
          <label htmlFor="si-wp-username">WordPress 用户名</label>
          <input id="si-wp-username" className="si-setting-input" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required />
          <label htmlFor="si-wp-application-password">应用程序密码</label>
          <input id="si-wp-application-password" className="si-setting-input" type="password" autoComplete="new-password" value={applicationPassword} onChange={(event) => setApplicationPassword(event.target.value)} required />
          <small>提交后输入框会清空。密码不会回显，也不会写入项目文件。</small>
        </form>
      </Drawer>
      <ConfirmDialog
        open={Boolean(pendingDelete)}
        onOpenChange={(open) => { if (!open) setPendingDelete(null); }}
        title="删除本机凭据？"
        description={pendingDelete ? `将从本机安全存储中删除 ${pendingDelete.origin} 的凭据，不会更改项目文件或其他网站的凭据。` : "将删除该网站的本机凭据。"}
        confirmLabel={deleting ? "删除中…" : "删除本机凭据"}
        tone="danger"
        onConfirm={deleteCredentials}
      />
    </Card>
  );
}
