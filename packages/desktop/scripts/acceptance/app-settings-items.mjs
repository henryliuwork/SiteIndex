import { readFile, stat } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { assertPersisted } from "./report.mjs";
import { waitForObserved } from "./session.mjs";

// v0.8.2 matrix rows 67–83; the shared driver owns each isolated session and upgrade.
export const APP_SETTINGS_ITEMS = [
  { id: 67, kind: "text", path: "projects_root", tab: "basic", name: "项目根目录" },
  { id: 68, kind: "text", path: "device_name", tab: "basic", name: "本机设备名" },
  { id: 69, kind: "text", path: "cache_dir", tab: "basic", name: "本机缓存目录" },
  { id: 70, kind: "checkbox", path: "close_to_tray", tab: "basic", name: "关闭窗口时最小化到托盘", expected: false },
  { id: 71, kind: "checkbox", path: "launch_at_login", tab: "basic", name: "开机时启动 SiteIndex", expected: true, systemState: true },
  { id: 72, kind: "browser", path: "browser.channel", tab: "environment", expected: "custom" },
  { id: 73, kind: "browser", path: "browser.executable_path", tab: "environment" },
  { id: 74, kind: "checkbox", path: "notify.on_failure", tab: "notifications", name: "失败时", expected: false },
  { id: 75, kind: "checkbox", path: "notify.on_success", tab: "notifications", name: "成功时", expected: true },
  { id: 76, kind: "threshold", path: "notify.oos_threshold", tab: "notifications", expected: 0.17 },
  { id: 77, kind: "webhook", path: "notify.dingtalk_webhook", tab: "notifications" },
  { id: 78, kind: "platform", path: "skill_platforms", tab: "skills" },
  { id: 79, kind: "add-project", path: "extra_projects" },
  { id: 80, kind: "remove-project", path: "hidden_projects" },
  { id: 81, kind: "ipc", path: "conflict_patterns" },
  { id: 82, kind: "credential" },
  { id: 83, kind: "schedule", systemState: true },
];

export function appSettingsItem(id, values) {
  const template = APP_SETTINGS_ITEMS.find((entry) => entry.id === id);
  if (!template) throw new Error(`Unknown app settings matrix row ${id}`);
  const expected = template.expected ?? ({
    67: values.projects_root, 68: values.device_name, 69: values.cache_dir,
    73: values.browser.executable_path, 77: values.notify.dingtalk_webhook,
    78: values.skillDirectory, 79: [values.extraProject], 80: [values.hiddenProject],
    81: values.conflict_patterns,
  })[id];
  return { ...template, expected };
}

const valueAt = (source, key) => key.split(".").reduce((part, segment) => part?.[segment], source);
const settingsFromPage = (page) => page.evaluate(() => window.siteindex.settings.get());
const passwordFocused = (page, label) => page.evaluate((expected) => {
  const active = document.activeElement;
  return active instanceof HTMLInputElement && active.type === "password"
    && [...(active.labels ?? [])].some((node) => node.textContent?.trim() === expected);
}, label);

/** Uses role locators or stable test IDs; caller owns route and isolated process. */
export async function editAppSettingsItem(page, item, values) {
  if (item.kind === "ipc") {
    await page.evaluate((patterns) => window.siteindex.settings.set({ conflict_patterns: patterns }), item.expected);
  } else if (item.kind === "credential" || item.kind === "schedule") {
    throw new Error(`Row ${item.id} requires its dedicated system operation`);
  } else if (item.kind === "add-project") {
    await page.getByRole("button", { name: "添加已有项目" }).click();
    const dialog = page.getByRole("dialog", { name: "添加已有项目" });
    await dialog.getByRole("textbox", { name: "项目文件夹路径" }).fill(values.extraProject);
    await dialog.getByRole("button", { name: "添加项目", exact: true }).click();
  } else if (item.kind === "remove-project") {
    await page.getByRole("button", { name: `${values.hiddenProjectName ?? "Synthetic hidden project"}更多操作` }).click();
    await page.getByRole("button", { name: "移除项目", exact: true }).first().click();
    await page.getByRole("dialog").getByRole("button", { name: "移除项目", exact: true }).click();
  } else {
    const tab = { environment: "浏览器与命令行", notifications: "通知", skills: "Agent 平台" }[item.tab];
    if (tab) await page.getByRole("tab", { name: tab }).click();
    if (item.kind === "text" || item.kind === "browser") {
      const control = page.getByRole("textbox", { name: item.kind === "browser" ? "自定义路径" : item.name });
      await control.fill(item.kind === "browser" ? values.browser.executable_path : item.expected);
      await control.press("Tab");
    } else if (item.kind === "checkbox") {
      const control = page.getByRole("checkbox", { name: item.name, exact: true });
      if (await control.isChecked() === item.expected) {
        await control.click();
        await waitForObserved(async () => valueAt(await settingsFromPage(page), item.path) !== item.expected,
          { label: `app setting row ${item.id} intermediate state` });
      }
      await control.click();
    } else if (item.kind === "threshold") {
      const toggle = page.getByRole("checkbox", { name: "新缺货达到阈值时" });
      if (!await toggle.isChecked()) await toggle.click();
      const control = page.getByRole("spinbutton", { name: "新缺货阈值百分比" });
      await control.fill(String(item.expected * 100));
      await control.press("Tab");
    } else if (item.kind === "webhook") {
      // Password input has no stable role in the baseline. Reach it from the named adjacent button.
      await page.getByRole("button", { name: "发送测试" }).focus();
      await page.keyboard.press("Shift+Tab");
      if (!await passwordFocused(page, "钉钉机器人 Webhook")) throw new Error("Webhook password focus path changed");
      await page.keyboard.type(item.expected);
      await page.keyboard.press("Tab");
    } else if (item.kind === "platform") {
      await page.getByRole("button", { name: "添加平台目录" }).click();
      await waitForObserved(async () => (await settingsFromPage(page)).skill_platforms.some((entry) => entry.name === "新平台"),
        { label: "new synthetic platform" });
      const control = page.getByRole("textbox", { name: "新平台 Skill 目录" }).last();
      await control.fill(item.expected);
      await control.press("Tab");
    }
  }
  await waitForObserved(async () => {
    const settings = await settingsFromPage(page);
    if (item.kind === "platform") return settings.skill_platforms.some((entry) => entry.dir === item.expected);
    return isDeepStrictEqual(valueAt(settings, item.path), item.expected);
  }, { label: `app setting row ${item.id} IPC save` });
}

export async function verifyAppSettingsFile(item, settingsFile) {
  const settings = JSON.parse(await readFile(settingsFile, "utf8"));
  const actual = item.kind === "platform" ? settings.skill_platforms.some((entry) => entry.dir === item.expected)
    : valueAt(settings, item.path);
  assertPersisted(actual, item.kind === "platform" ? true : item.expected);
  return { id: item.id, phase: "file-readback", status: "passed" };
}

export async function verifyAppSettingsIpc(item, page) {
  const settings = await settingsFromPage(page);
  const actual = item.kind === "platform" ? settings.skill_platforms.some((entry) => entry.dir === item.expected)
    : valueAt(settings, item.path);
  assertPersisted(actual, item.kind === "platform" ? true : item.expected);
  return { id: item.id, phase: "ipc-readback", status: "passed" };
}

const CREDENTIAL_STATES = new Set(["configured", "not_configured", "needs_reentry", "unavailable"]);

/** Only status, secure-storage availability and encrypted-file existence may enter evidence. */
export async function credentialStateEvidence(page, origin, vaultFile) {
  const status = await page.evaluate((siteUrl) => window.siteindexWindow.wordpressCredentials.status(siteUrl), origin);
  if (!CREDENTIAL_STATES.has(status?.state)) throw new Error("Invalid credential status enum");
  const exists = await stat(vaultFile).then(() => true, (error) => {
    if (error?.code === "ENOENT") return false;
    throw error;
  });
  return { state: status.state, safeStorageAvailable: status.state !== "unavailable", encryptedFileExists: exists };
}

/** Credential material is supplied at runtime and never returned or written to a report. */
export async function editCredentialItem(page, origin, username, applicationPassword) {
  const status = await page.evaluate((siteUrl) => window.siteindexWindow.wordpressCredentials.status(siteUrl), origin);
  if (status?.state === "unavailable") throw new Error("Safe storage unavailable for credential row");
  const target = page.getByRole("region", { name: `凭据：${origin}` });
  await target.getByRole("button", { name: /^(配置凭据|重新录入|替换凭据)$/u }).click();
  const user = page.getByRole("textbox", { name: "WordPress 用户名" });
  await user.fill(username);
  await user.press("Tab");
  if (!await passwordFocused(page, "应用程序密码")) throw new Error("Credential password focus path changed");
  await page.keyboard.type(applicationPassword);
  await page.getByRole("button", { name: "保存到本机" }).click();
  await waitForObserved(async () => (await page.evaluate((siteUrl) =>
    window.siteindexWindow.wordpressCredentials.status(siteUrl), origin)).state === "configured",
  { label: "credential status after UI save" });
}

export const SCHEDULE_JOBS = ["daily", "validate", "weekly", "readme", "monthly"];
export const SCHEDULE_DAILY = { enabled: true, days: [2, 4], time: "17:44" };
export const SCHEDULE_SYSTEM_EXPECTED = {
  daily: { time: "17:44", weekdays: ["Tuesday", "Thursday"] },
  validate: { time: "02:30", weekdays: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] },
  weekly: { time: "03:00", weekdays: ["Monday"] },
  readme: { time: "05:00", weekdays: ["Sunday"] },
  monthly: { time: "04:00", monthDay: "1" },
};

export async function editScheduleItem(page, projectId) {
  await page.getByRole("button", { name: "改为本机" }).click();
  await waitForObserved(async () => (await page.evaluate((id) => window.siteindex.runner.get(id), projectId)).is_this_device,
    { label: "scheduled project runner claim" });
  await page.getByRole("button", { name: "编辑", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "编辑每日同步计划" });
  const weekdays = dialog.getByRole("group", { name: "执行星期" });
  for (const label of ["一", "三", "五", "六", "日"]) await weekdays.getByRole("button", { name: label, exact: true }).click();
  await dialog.getByRole("textbox", { name: "执行时间" }).fill(SCHEDULE_DAILY.time);
  await dialog.getByRole("button", { name: "保存计划" }).click();
  await waitForObserved(async () => {
    const state = await page.evaluate((id) => window.siteindex.schedule.get(id), projectId);
    return state.registered && isDeepStrictEqual(state.config.daily, SCHEDULE_DAILY);
  }, { label: "daily schedule UI save" });
}

export async function verifyScheduleFile(siteFile) {
  const config = JSON.parse(await readFile(siteFile, "utf8"));
  assertPersisted(config.schedule?.daily, SCHEDULE_DAILY);
  return { id: 83, phase: "file-readback", status: "passed" };
}

export async function verifyScheduleIpc(page, projectId) {
  const state = await page.evaluate(async (id) => ({
    project: await window.siteindex.projects.get(id),
    schedule: await window.siteindex.schedule.get(id),
    verify: await window.siteindex.schedule.verify(id),
  }), projectId);
  assertPersisted(state.schedule.config, state.project.config.schedule);
  assertPersisted(state.schedule.config.daily, SCHEDULE_DAILY);
  assertPersisted(state.verify.state, "ok");
  return { id: 83, phase: "ipc-readback", status: "passed" };
}

/** System state is supplied by the driver after inspecting Windows startup/schedule registrations. */
export function verifySystemSetting(item, observed) {
  if (!item.systemState) throw new Error(`Row ${item.id} has no system state`);
  if (item.id === 71) assertPersisted(observed.launchAtLogin, item.expected);
  if (item.id === 83) {
    if (!observed.executable || !observed.projectPath) throw new Error("Schedule installation paths are missing");
    if (observed.tasks?.length !== SCHEDULE_JOBS.length
      || new Set(observed.tasks.map((task) => task.job)).size !== SCHEDULE_JOBS.length
      || !observed.tasks.every((task) =>
      SCHEDULE_JOBS.includes(task.job) && task.registered && task.xmlReadable)) {
      throw new Error("Five Windows schedule tasks were not registered with readable XML");
    }
    for (const task of observed.tasks) {
      const expected = SCHEDULE_SYSTEM_EXPECTED[task.job];
      assertPersisted(task.command?.toLowerCase(), observed.executable?.toLowerCase());
      assertPersisted(task.workingDirectory?.toLowerCase(), observed.projectPath?.toLowerCase());
      assertPersisted(task.arguments, `--run-job "${observed.projectPath}" ${task.job}`);
      assertPersisted(task.time, expected.time);
      assertPersisted(task.triggerCount, 1);
      assertPersisted(task.actionCount, 1);
      assertPersisted(task.enabled ?? true, true);
      if (expected.weekdays) assertPersisted([...task.weekdays].sort(), [...expected.weekdays].sort());
      if (expected.monthDay) assertPersisted(task.monthDay, expected.monthDay);
    }
  }
  return { id: item.id, phase: "system-readback", status: "passed" };
}
