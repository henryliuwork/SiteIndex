import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import type { AppSettings, SkillPlatform } from "@siteindex/shared";
import { api, apiErrorMessage } from "../api";
import { ApiErrorNotice, Button, Chip, TabPanel, Tabs } from "../components";
import { displayVersion, updateStatusLabel, useAnyRunningJob, useUpdatesController } from "../updates";
import "./app-settings/page.css";

const RELEASES_URL = "https://github.com/henryliuwork/SiteIndex/releases/latest";
const settingsTabs = [
  { value: "basic", label: "基本信息" },
  { value: "environment", label: "浏览器与命令行" },
  { value: "notifications", label: "通知" },
  { value: "skills", label: "Agent 平台" },
  { value: "about", label: "关于" },
] as const;
type SettingsTab = (typeof settingsTabs)[number]["value"];

export function AppSettingsPage() {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<SettingsTab>("basic");
  const settingsQuery = useQuery({ queryKey: ["settings"], queryFn: () => api.settings.get() });
  const browserQuery = useQuery({ queryKey: ["settings", "browser"], queryFn: () => api.settings.detectBrowser(), enabled: activeTab === "environment" });
  const cliQuery = useQuery({ queryKey: ["settings", "cli"], queryFn: () => api.settings.cliStatus(), enabled: activeTab === "environment" });
  const platformQuery = useQuery({ queryKey: ["app", "platform"], queryFn: () => api.app.platform() });
  const versionQuery = useQuery({ queryKey: ["app", "version"], queryFn: () => api.app.version(), enabled: activeTab === "about" });
  const skillsQuery = useQuery({ queryKey: ["skills"], queryFn: () => api.skills.list(), enabled: activeTab === "about" });
  const updates = useUpdatesController();
  const runningJobsQuery = useAnyRunningJob(activeTab === "about" && updates.status?.state === "ready");
  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [testingBrowser, setTestingBrowser] = useState(false);
  const [installingCli, setInstallingCli] = useState(false);
  const [sendingTestNotification, setSendingTestNotification] = useState(false);
  const [openingLogs, setOpeningLogs] = useState(false);
  const [feedback, setFeedback] = useState("");

  useEffect(() => {
    if (settingsQuery.data) setDraft(settingsQuery.data);
  }, [settingsQuery.data]);

  const saveSettings = async (patch: Partial<AppSettings>, message = "已保存") => {
    if (saving) return;
    setSaving(true);
    setFeedback("");
    try {
      const saved = await api.settings.set(patch);
      queryClient.setQueryData(["settings"], saved);
      setDraft(saved);
      setFeedback(message);
    } catch (error) {
      setFeedback("保存失败：" + (apiErrorMessage(error, "请稍后重试")));
    } finally {
      setSaving(false);
      window.setTimeout(() => setFeedback(""), 2600);
    }
  };

  const saveNotify = <K extends keyof AppSettings["notify"],>(key: K, value: AppSettings["notify"][K]) => {
    if (!draft) return;
    const notify = { ...draft.notify, [key]: value };
    setDraft({ ...draft, notify });
    void saveSettings({ notify });
  };

  const saveBrowserPath = () => {
    if (draft) void saveSettings({ browser: draft.browser });
  };

  const chooseProjectsRoot = async () => {
    if (!draft) return;
    try {
      const selected = await api.settings.chooseDirectory(draft.projects_root);
      if (selected) await saveSettings({ projects_root: selected });
    } catch (error) {
      setFeedback("选择目录失败：" + (apiErrorMessage(error, "请稍后重试")));
    }
  };

  const testBrowser = async () => {
    if (!draft || testingBrowser) return;
    setTestingBrowser(true);
    setFeedback("");
    try {
      const saved = await api.settings.set({ browser: draft.browser });
      queryClient.setQueryData(["settings"], saved);
      setDraft(saved);
      const result = await browserQuery.refetch();
      setFeedback(result.data?.available ? `检测到 ${result.data.name ?? "可用浏览器"}` : "未检测到可用浏览器，请检查自定义路径");
    } catch (error) {
      setFeedback("浏览器检测失败：" + (apiErrorMessage(error, "请稍后重试")));
    } finally {
      setTestingBrowser(false);
      window.setTimeout(() => setFeedback(""), 3000);
    }
  };

  const installCli = async () => {
    if (installingCli) return;
    setInstallingCli(true);
    setFeedback("");
    try {
      const status = await api.settings.installCli();
      queryClient.setQueryData(["settings", "cli"], status);
      setFeedback(status.installed ? "siteindex 命令已安装" : "安装未完成");
    } catch (error) {
      setFeedback("安装失败：" + (apiErrorMessage(error, "请稍后重试")));
    } finally {
      setInstallingCli(false);
      window.setTimeout(() => setFeedback(""), 2600);
    }
  };

  const sendTestNotification = async () => {
    if (!api.settings.sendTestNotification || sendingTestNotification) return;
    setSendingTestNotification(true);
    setFeedback("");
    try {
      await api.settings.sendTestNotification();
      setFeedback("测试通知已发送");
    } catch (error) {
      setFeedback("发送测试通知失败：" + (apiErrorMessage(error, "请稍后重试")));
    } finally {
      setSendingTestNotification(false);
      window.setTimeout(() => setFeedback(""), 3000);
    }
  };

  const openLogs = async () => {
    if (!api.settings.openLogs || openingLogs) return;
    setOpeningLogs(true);
    setFeedback("");
    try {
      await api.settings.openLogs();
      setFeedback("已打开日志目录");
    } catch (error) {
      setFeedback("打开日志目录失败：" + (apiErrorMessage(error, "请稍后重试")));
    } finally {
      setOpeningLogs(false);
      window.setTimeout(() => setFeedback(""), 3000);
    }
  };

  const checkUpdates = async () => {
    if (updates.updates) {
      await updates.run("check");
      return;
    }
    try { await api.shell.openExternal(RELEASES_URL); }
    catch (error) { setFeedback("无法打开下载页面：" + apiErrorMessage(error, "请稍后重试")); }
  };

  const openManualUpdate = async (url: string) => {
    try { await api.shell.openExternal(url); }
    catch (error) { setFeedback("无法打开下载页面：" + apiErrorMessage(error, "请稍后重试")); }
  };

  const savePlatforms = (skillPlatforms: SkillPlatform[]) => {
    if (!draft) return;
    setDraft({ ...draft, skill_platforms: skillPlatforms });
    void saveSettings({ skill_platforms: skillPlatforms });
  };

  const savePlatform = () => {
    if (draft) void saveSettings({ skill_platforms: draft.skill_platforms });
  };

  if (settingsQuery.isError) return <ApiErrorNotice page label="软件设置加载失败。" error={settingsQuery.error} onRetry={() => void settingsQuery.refetch()} />;
  if (settingsQuery.isLoading || !draft) return <div className="si-page-loading" role="status">正在加载软件设置…</div>;

  const settingsPath = platformQuery.data === "darwin" ? "~/Library/Application Support/SiteIndex/settings.json" : "%APPDATA%\\SiteIndex\\settings.json";
  const logsPath = platformQuery.data === "darwin" ? "~/Library/Logs/SiteIndex" : "%APPDATA%\\SiteIndex\\logs";
  const browserStatus = browserQuery.data;
  const cliStatus = cliQuery.data;
  const manualUpdateUrl = updates.status?.state === "unsupported" ? updates.status.manual_url : undefined;

  return (
    <div className="si-page si-app-settings-page">
      <header className="si-app-settings-heading"><h1>设置</h1><code>{settingsPath} · 只对本机生效</code></header>
      <Tabs value={activeTab} options={settingsTabs} onChange={setActiveTab} ariaLabel="软件设置分区" tabIdPrefix="app-settings-tab" panelIdPrefix="app-settings-panel" />
      {platformQuery.isError && <ApiErrorNotice label="系统平台信息读取失败。" error={platformQuery.error} onRetry={() => void platformQuery.refetch()} />}
      {feedback && <p className="si-feedback" role="status">{feedback}</p>}

      <TabPanel id={`app-settings-panel-${activeTab}`} labelledBy={`app-settings-tab-${activeTab}`}>
      {activeTab === "basic" && <section className="si-app-settings-card">
        <h2>常规</h2>
        <div className="si-app-setting-row">
          <label htmlFor="si-projects-root">项目根目录</label>
          <input id="si-projects-root" className="si-setting-input si-setting-mono" value={draft.projects_root} onChange={(event) => setDraft({ ...draft, projects_root: event.target.value })} onBlur={() => void saveSettings({ projects_root: draft.projects_root })} />
          <Button onClick={() => void chooseProjectsRoot()}>选择…</Button>
        </div>
        <div className="si-app-setting-row">
          <label htmlFor="si-device-name">本机设备名</label>
          <input id="si-device-name" className="si-setting-input" value={draft.device_name} onChange={(event) => setDraft({ ...draft, device_name: event.target.value })} onBlur={() => void saveSettings({ device_name: draft.device_name })} />
          <span className="si-setting-hint">执行设备按此名称识别</span>
        </div>
        <div className="si-app-setting-row">
          <label htmlFor="si-cache-dir">本机缓存目录</label>
          <input id="si-cache-dir" className="si-setting-input si-setting-mono" value={draft.cache_dir} onChange={(event) => setDraft({ ...draft, cache_dir: event.target.value })} onBlur={() => void saveSettings({ cache_dir: draft.cache_dir })} />
          <span className="si-setting-hint">数据库等不进云盘</span>
        </div>
      </section>}

      {activeTab === "environment" && <>
      <section className="si-app-settings-card">
        <h2>浏览器（设计规范提取）</h2>
        <div className="si-app-setting-row si-browser-detected">
          <strong>检测到的浏览器</strong>
          {browserQuery.isLoading ? <span className="si-setting-hint" role="status">正在检测…</span> : browserQuery.isError ? <ApiErrorNotice className="si-setting-error" label="浏览器检测失败" error={browserQuery.error} onRetry={() => void browserQuery.refetch()} /> : <span><code>{browserStatus?.name ?? "未检测到浏览器"}</code>{browserStatus?.path && <code className="si-setting-hint si-setting-path">{browserStatus.path}</code>}</span>}
          <Chip tone={browserStatus?.available ? "ok" : "warn"}>{browserStatus?.available ? "可用" : "不可用"}</Chip>
        </div>
        <div className="si-app-setting-row">
          <label htmlFor="si-browser-path">自定义路径</label>
          <input id="si-browser-path" className="si-setting-input si-setting-mono" placeholder="留空则自动使用 Edge / Chrome" value={draft.browser.executable_path ?? ""} onChange={(event) => setDraft({ ...draft, browser: { ...draft.browser, channel: event.target.value ? "custom" : "msedge", executable_path: event.target.value || null } })} onBlur={saveBrowserPath} />
          <Button disabled={testingBrowser} onClick={() => void testBrowser()}>{testingBrowser ? "检测中…" : "测试"}</Button>
        </div>
      </section>

      <section className="si-app-settings-card">
        <h2>命令行</h2>
        <div className="si-app-setting-row">
          <strong>siteindex 命令</strong>
          <span>安装后可在任意终端和 agent 中使用 <code>siteindex …</code></span>
          <Button variant="primary" disabled={installingCli || cliStatus?.installed} onClick={() => void installCli()}>{installingCli ? "安装中…" : cliStatus?.installed ? "已安装" : "安装到 PATH"}</Button>
        </div>
        <div className="si-app-setting-row">
          <strong>状态</strong>
          {cliQuery.isLoading ? <span className="si-setting-hint" role="status">正在检查…</span> : cliQuery.isError ? <ApiErrorNotice className="si-setting-error" label="命令行状态读取失败" error={cliQuery.error} onRetry={() => void cliQuery.refetch()} /> : <code className="si-setting-hint si-setting-mono">{cliStatus?.path ?? "尚未安装"}</code>}
          <Chip tone={cliStatus?.installed ? "ok" : "warn"}>{cliStatus?.installed ? "已安装" : "未安装"}</Chip>
        </div>
      </section>
      </>}

      {activeTab === "notifications" && <section className="si-app-settings-card">
        <h2>通知</h2>
        <div className="si-app-setting-row si-notify-row">
          <strong>系统通知</strong>
          <div className="si-notify-options">
            <label><input type="checkbox" checked={draft.notify.on_failure} onChange={(event) => saveNotify("on_failure", event.target.checked)} />失败时</label>
            <label><input type="checkbox" checked={draft.notify.on_success} onChange={(event) => saveNotify("on_success", event.target.checked)} />成功时</label>
            <label><input type="checkbox" checked={draft.notify.oos_threshold !== null} onChange={(event) => saveNotify("oos_threshold", event.target.checked ? 0.12 : null)} />新缺货达到阈值时</label>
            {draft.notify.oos_threshold !== null && <label className="si-threshold-field">阈值 <input aria-label="新缺货阈值百分比" type="number" min="0" max="100" step="1" value={Math.round(draft.notify.oos_threshold * 100)} onChange={(event) => setDraft({ ...draft, notify: { ...draft.notify, oos_threshold: Number(event.target.value) / 100 } })} onBlur={() => void saveSettings({ notify: draft.notify })} />%</label>}
          </div>
          <span />
        </div>
        <div className="si-app-setting-row">
          <label htmlFor="si-dingtalk-webhook">钉钉机器人 Webhook</label>
          <input id="si-dingtalk-webhook" className="si-setting-input si-setting-mono" type="password" autoComplete="new-password" placeholder="https://oapi.dingtalk.com/robot/send?access_token=…" value={draft.notify.dingtalk_webhook ?? ""} onChange={(event) => setDraft({ ...draft, notify: { ...draft.notify, dingtalk_webhook: event.target.value || null } })} onBlur={() => void saveSettings({ notify: draft.notify })} />
          {api.settings.sendTestNotification && <Button disabled={sendingTestNotification} onClick={() => void sendTestNotification()}>{sendingTestNotification ? "发送中…" : "发送测试"}</Button>}
        </div>
      </section>}

      {activeTab === "skills" && <section className="si-app-settings-card">
        <h2>Agent 平台 Skill 目录</h2>
        {draft.skill_platforms.map((platform, index) => {
          const detectedPlatform = platform.id === "claude-code" && platform.detected;
          const editablePlatform = platform.id === "codex" || platform.id.startsWith("custom-");
          return <div className="si-app-setting-row" key={platform.id}>
            <strong>{platform.name}</strong>
            {detectedPlatform || platform.id === "qwenpaw" ? <code className="si-setting-mono si-platform-path">{platform.dir}</code> : <input aria-label={`${platform.name} Skill 目录`} className="si-setting-input si-setting-mono" value={platform.dir} onChange={(event) => setDraft({ ...draft, skill_platforms: draft.skill_platforms.map((item, itemIndex) => itemIndex === index ? { ...item, dir: event.target.value, detected: false } : item) })} onBlur={editablePlatform && platform.id !== "codex" ? () => void saveSettings({ skill_platforms: draft.skill_platforms }) : undefined} />}
            <div className="si-platform-actions">
              {detectedPlatform ? <Chip tone="ok">已检测到</Chip> : editablePlatform && platform.id === "codex" ? <Button onClick={savePlatform}>保存</Button> : <Button aria-label={`移除 ${platform.name}`} onClick={() => savePlatforms(draft.skill_platforms.filter((_, itemIndex) => itemIndex !== index))}>移除</Button>}
            </div>
          </div>;
        })}
        <div className="si-platform-add-row"><Button icon={<Plus size={15} />} onClick={() => savePlatforms([...draft.skill_platforms, { id: `custom-${Date.now()}`, name: "新平台", dir: "", detected: false }])}>添加平台目录</Button></div>
      </section>}

      {activeTab === "about" && <section className="si-app-settings-card">
        <h2>关于</h2>
        <div className="si-app-setting-row">
          <strong>版本</strong>
          <span>SiteIndex {versionQuery.isError ? "版本读取失败" : displayVersion(versionQuery.data)} · 数据规范 1.1 · 内置 Skill {skillsQuery.isError ? "清单读取失败" : skillsQuery.data?.length ?? "…"} 个</span>
          <Button disabled={versionQuery.isLoading || updates.query.isFetching || updates.busy === "check"} onClick={() => void checkUpdates()}>{updates.query.isFetching || updates.busy === "check" ? "检查中…" : "检查更新"}</Button>
        </div>
        {versionQuery.isError && <ApiErrorNotice label="版本信息读取失败。" error={versionQuery.error} onRetry={() => void versionQuery.refetch()} />}
        {skillsQuery.isError && <ApiErrorNotice label="Skill 清单读取失败。" error={skillsQuery.error} onRetry={() => void skillsQuery.refetch()} />}
        {updates.updates && <div className="si-app-setting-row si-update-settings-row">
          <strong>更新状态</strong>
          <div className="si-update-settings-detail" aria-live="polite">
            {updates.status?.state === "error" ? <ApiErrorNotice className="si-update-error" label="检查更新失败。" error={updates.query.error} detail={updates.status.error} /> : <span>{updateStatusLabel(updates.status, updates.query.isFetching || updates.busy === "check")}</span>}
            {updates.status?.state === "ready" && runningJobsQuery.data && <small>将在当前任务完成后安装</small>}
            {updates.status?.state === "ready" && runningJobsQuery.isLoading && <small role="status">正在读取当前任务状态…</small>}
            {updates.status?.state === "ready" && runningJobsQuery.projectsQuery.isError && <ApiErrorNotice label="项目列表读取失败，暂时无法确认当前是否有任务运行。" error={runningJobsQuery.projectsQuery.error} onRetry={() => void runningJobsQuery.projectsQuery.refetch()} />}
            {updates.status?.state === "ready" && runningJobsQuery.isError && <ApiErrorNotice label="当前任务状态读取失败。" error={runningJobsQuery.error} onRetry={() => void runningJobsQuery.refetch()} />}
            {updates.status?.state === "downloading" && <div className="si-update-progress" role="progressbar" aria-label="更新下载进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.max(0, Math.min(100, updates.status.percent ?? 0))}><span style={{ width: `${Math.max(0, Math.min(100, updates.status.percent ?? 0))}%` }} /></div>}
            {updates.status?.notes?.trim() && <details className="si-update-notes"><summary>查看更新说明</summary><pre>{updates.status.notes}</pre></details>}
          </div>
          <div className="si-update-settings-actions">
            {updates.status?.state === "available" && <Button size="small" disabled={Boolean(updates.busy)} onClick={() => void updates.run("download")}>{updates.busy === "download" ? "开始下载…" : "下载更新"}</Button>}
            {updates.status?.state === "ready" && <Button size="small" variant="primary" disabled={Boolean(updates.busy) || runningJobsQuery.isLoading || runningJobsQuery.projectsQuery.isError || runningJobsQuery.isError} onClick={() => void updates.run("install")}>{updates.busy === "install" ? "正在重启…" : "重启并安装"}</Button>}
            {manualUpdateUrl && <Button size="small" onClick={() => void openManualUpdate(manualUpdateUrl)}>前往下载</Button>}
            {updates.status?.state === "error" && <Button size="small" disabled={Boolean(updates.busy)} onClick={() => void updates.run("check")}>{updates.busy === "check" ? "检查中…" : "重试"}</Button>}
          </div>
        </div>}
        <div className="si-app-setting-row">
          <strong>日志</strong>
          <code className="si-setting-hint si-setting-mono">{logsPath}</code>
          {api.settings.openLogs && <Button disabled={openingLogs} onClick={() => void openLogs()}>{openingLogs ? "打开中…" : "打开"}</Button>}
        </div>
      </section>}
      </TabPanel>
      {saving && <span className="si-sr-only" role="status">正在保存软件设置…</span>}
    </div>
  );
}
