import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

/** Each v0.8.0 UI save gets a fresh packaged process; only synthetic values are used. */
export async function exerciseBaselineAppSettings({ launch, stop, settingsPath, values }) {
  const rows = [];
  const at = (source, key) => key.split(".").reduce((part, segment) => part?.[segment], source);
  const blur = async (page, selector, value) => {
    await page.locator(selector).fill(value);
    await page.locator(selector).press("Tab");
  };
  const run = async (ids, { route = "#/settings", tab, action, verify, skillDirectory, cancelPicker = false }) => {
    let stage = "launch";
    try {
      const page = await launch(cancelPicker);
      stage = "UI save";
      await page.evaluate((hash) => { window.location.hash = hash; }, route);
      if (route === "#/settings") {
        await page.locator("#si-device-name").waitFor();
        if (tab) await page.getByRole("tab", { name: tab }).click();
      } else await page.getByRole("button", { name: "添加已有项目" }).waitFor();
      await action(page);
      stage = "IPC readback";
      await page.waitForFunction(async ({ paths, skillDirectory: directory }) => {
        const settings = await window.siteindex.settings.get();
        return paths.every(([key, expected]) => JSON.stringify(key.split(".").reduce((part, segment) =>
          part?.[segment], settings)) === JSON.stringify(expected))
          && (!directory || settings.skill_platforms.some((entry) => entry.dir === directory));
      }, { paths: verify, skillDirectory }, { timeout: 12_000 });
      await page.getByText("正在保存软件设置…").waitFor({ state: "hidden", timeout: 12_000 });
      stage = "process exit";
      await stop();
      stage = "settings.json readback";
      const disk = JSON.parse(await readFile(settingsPath, "utf8"));
      for (const [key, expected] of verify) assert.deepEqual(at(disk, key), expected, `disk readback: ${key}`);
      if (skillDirectory) assert(disk.skill_platforms.some((entry) => entry.dir === skillDirectory), "disk readback: skill_platforms");
      for (const id of ids) rows.push({ id, status: "passed", evidence: "separate baseline UI session + IPC/file readback" });
    } catch (error) {
      await stop();
      for (const id of ids) rows.push({ id, status: "failed", stage, errorType: error?.name ?? "Error" });
      const failure = new Error(`baseline UI setting ${ids.join("/")} failed at ${stage}: ${error?.name ?? "Error"}`);
      failure.uiRows = rows;
      throw failure;
    }
  };
  await run([67], { cancelPicker: true, action: (page) => blur(page, "#si-projects-root", values.projects_root), verify: [["projects_root", values.projects_root]] });
  await run([68], { action: (page) => blur(page, "#si-device-name", values.device_name), verify: [["device_name", values.device_name]] });
  await run([69], { action: (page) => blur(page, "#si-cache-dir", values.cache_dir), verify: [["cache_dir", values.cache_dir]] });
  await run([70], { action: async (page) => {
    const toggle = page.getByRole("checkbox", { name: "关闭窗口时最小化到托盘" });
    await toggle.click();
    await page.waitForFunction(async () => (await window.siteindex.settings.get()).close_to_tray === true);
    await page.getByText("正在保存软件设置…").waitFor({ state: "hidden", timeout: 12_000 });
    await toggle.click();
  }, verify: [["close_to_tray", false]] });
  await run([72, 73], { tab: "浏览器与命令行", action: (page) => blur(page, "#si-browser-path", values.browser.executable_path),
    verify: [["browser.channel", "custom"], ["browser.executable_path", values.browser.executable_path]] });
  await run([74], { tab: "通知", action: (page) => page.getByRole("checkbox", { name: "失败时", exact: true }).click(), verify: [["notify.on_failure", false]] });
  await run([75], { tab: "通知", action: (page) => page.getByRole("checkbox", { name: "成功时", exact: true }).click(), verify: [["notify.on_success", true]] });
  await run([76], { tab: "通知", action: async (page) => {
    await page.getByRole("checkbox", { name: "新缺货达到阈值时" }).click();
    await page.waitForFunction(async () => (await window.siteindex.settings.get()).notify.oos_threshold === 0.12);
    await page.getByText("正在保存软件设置…").waitFor({ state: "hidden" });
    await page.getByRole("spinbutton", { name: "新缺货阈值百分比" }).fill("12");
    await page.getByRole("spinbutton", { name: "新缺货阈值百分比" }).press("Tab");
  }, verify: [["notify.oos_threshold", 0.12]] });
  await run([77], { tab: "通知", action: (page) => blur(page, "#si-dingtalk-webhook", values.notify.dingtalk_webhook),
    verify: [["notify.dingtalk_webhook", values.notify.dingtalk_webhook]] });
  await run([78], { tab: "Agent 平台", action: async (page) => {
    await page.getByRole("button", { name: "添加平台目录" }).click();
    await page.waitForFunction(async () => (await window.siteindex.settings.get()).skill_platforms.some((entry) => entry.name === "新平台"));
    await page.getByText("正在保存软件设置…").waitFor({ state: "hidden" });
    const input = page.getByRole("textbox", { name: "新平台 Skill 目录" }).last();
    await input.fill(values.skillDirectory);
    await input.press("Tab");
  }, verify: [], skillDirectory: values.skillDirectory });
  await run([79], { route: "#/", action: async (page) => {
    await page.getByRole("button", { name: "添加已有项目" }).click();
    await page.locator("#existing-project-path").fill(values.extraProject);
    await page.getByRole("dialog").getByRole("button", { name: "添加项目", exact: true }).click();
  }, verify: [["extra_projects", [values.extraProject]]] });
  await run([80], { route: "#/", action: async (page) => {
    await page.getByRole("button", { name: "Synthetic hidden project更多操作" }).click();
    await page.getByRole("button", { name: "移除项目", exact: true }).first().click();
    await page.getByRole("dialog").getByRole("button", { name: "移除项目", exact: true }).click();
  }, verify: [["hidden_projects", [values.hiddenProject]]] });
  rows.push({ id: 81, status: "pending-api", evidence: "no UI; settings.set/get and file readback in harness" });
  let stage = "vault status";
  try {
    const page = await launch();
    await page.evaluate(() => { window.location.hash = "#/settings"; });
    await page.locator("#si-device-name").waitFor();
    const status = await page.evaluate((origin) => window.siteindexWindow?.wordpressCredentials?.status(origin), values.wpOrigin);
    if (status?.state === "unavailable") {
      rows.push({ id: 82, status: "unverified", evidence: "runner OS safe storage unavailable; no credential submitted" });
      await stop();
    } else {
      stage = "credential UI save";
      await page.getByRole("heading", { name: "WordPress 图片托管凭据" }).waitFor();
      await page.getByRole("button", { name: "配置凭据" }).first().click();
      await page.locator("#si-wp-username").fill("fixture-only-user");
      await page.locator("#si-wp-application-password").fill("fixture-only-password");
      await page.getByRole("button", { name: "保存到本机" }).click();
      await page.waitForFunction(async (origin) =>
        (await window.siteindexWindow?.wordpressCredentials?.status(origin))?.state === "configured",
      values.wpOrigin, { timeout: 12_000 });
      await stop();
      stage = "fresh vault status";
      const fresh = await launch();
      assert.equal((await fresh.evaluate((origin) =>
        window.siteindexWindow?.wordpressCredentials?.status(origin), values.wpOrigin))?.state, "configured");
      await stop();
      rows.push({ id: 82, status: "passed", evidence: "baseline UI save + fresh process vault status only" });
    }
  } catch (error) {
    await stop();
    rows.push({ id: 82, status: "failed", stage, errorType: error?.name ?? "Error" });
    const failure = new Error(`baseline UI setting 82 failed at ${stage}: ${error?.name ?? "Error"}`);
    failure.uiRows = rows;
    throw failure;
  }
  rows.push({ id: 83, status: "unverified", evidence: "OS schedule registration deferred to independent-entry block" });
  return rows;
}

/** Candidate-only explicit clears; returns per-row evidence without echoing input values. */
export async function exerciseCandidateAppClears(page, origin) {
  const rows = [];
  const clear = async (id, selector, expectedPath, tabName) => {
    try {
      await page.getByRole("tab", { name: tabName }).click();
      await page.locator(selector).fill("");
      await page.locator(selector).press("Tab");
      await page.waitForFunction(async (key) => {
        const value = key.split(".").reduce((part, segment) => part?.[segment], await window.siteindex.settings.get());
        return value === null;
      }, expectedPath, { timeout: 12_000 });
      rows.push({ id, status: "passed", evidence: "candidate packaged UI explicit clear + IPC readback" });
    } catch (error) {
      rows.push({ id, status: "failed", evidence: "candidate packaged UI clear/readback failed",
        errorType: error?.name ?? "Error" });
    }
  };
  await page.evaluate(() => { window.location.hash = "#/settings"; });
  await page.locator("#si-device-name").waitFor();
  await clear(73, "#si-browser-path", "browser.executable_path", "浏览器与命令行");
  await clear(77, "#si-dingtalk-webhook", "notify.dingtalk_webhook", "通知");
  const status = await page.evaluate((siteUrl) => window.siteindexWindow?.wordpressCredentials?.status(siteUrl), origin);
  if (status?.state === "configured") {
    try {
      await page.getByRole("tab", { name: "基本信息" }).click();
      await page.getByRole("button", { name: "删除本机凭据" }).first().click();
      await page.getByRole("dialog").getByRole("button", { name: "删除本机凭据" }).click();
      await page.waitForFunction(async (siteUrl) =>
        (await window.siteindexWindow?.wordpressCredentials?.status(siteUrl))?.state === "not_configured",
      origin, { timeout: 12_000 });
      rows.push({ id: 82, status: "passed", evidence: "candidate packaged UI delete + vault status only" });
    } catch (error) {
      rows.push({ id: 82, status: "failed", evidence: "candidate packaged credential delete/status failed",
        errorType: error?.name ?? "Error" });
    }
  }
  return rows;
}

/** Read every saved application setting through the installed candidate UI, IPC and disk. */
export async function exerciseCandidateAppReadback(page, settingsPath, values) {
  const rows = [];
  const at = (source, key) => key.split(".").reduce((part, segment) => part?.[segment], source);
  const disk = JSON.parse(await readFile(settingsPath, "utf8"));
  const ipc = await page.evaluate(() => window.siteindex.settings.get());
  const check = async (id, key, matches, ui) => {
    try {
      assert(matches(at(disk, key)), `#${id} candidate file readback`);
      assert(matches(at(ipc, key)), `#${id} candidate IPC readback`);
      if (ui) await ui();
      rows.push({ id, status: "passed", evidence: ui ? "candidate UI + IPC + file" : "candidate IPC + file; no UI control" });
    } catch (error) { rows.push({ id, status: "failed", errorType: error?.name ?? "Error" }); }
  };
  const equal = (expected) => (actual) => JSON.stringify(actual) === JSON.stringify(expected);
  const input = async (selector, expected) => assert.equal(await page.locator(selector).inputValue(), expected);
  await page.evaluate(() => { window.location.hash = "#/settings"; });
  await page.locator("#si-device-name").waitFor();
  await check(67, "projects_root", equal(values.projects_root), () => input("#si-projects-root", values.projects_root));
  await check(68, "device_name", equal(values.device_name), () => input("#si-device-name", values.device_name));
  await check(69, "cache_dir", equal(values.cache_dir), () => input("#si-cache-dir", values.cache_dir));
  await check(70, "close_to_tray", equal(false), async () => assert.equal(
    await page.getByRole("checkbox", { name: "关闭窗口时最小化到托盘" }).isChecked(), false));
  await page.getByRole("tab", { name: "浏览器与命令行" }).click();
  await check(72, "browser.channel", equal("custom"), () => input("#si-browser-path", values.browser.executable_path));
  await check(73, "browser.executable_path", equal(values.browser.executable_path), () => input("#si-browser-path", values.browser.executable_path));
  await page.getByRole("tab", { name: "通知" }).click();
  await check(74, "notify.on_failure", equal(false), async () => assert.equal(
    await page.getByRole("checkbox", { name: "失败时", exact: true }).isChecked(), false));
  await check(75, "notify.on_success", equal(true), async () => assert.equal(
    await page.getByRole("checkbox", { name: "成功时", exact: true }).isChecked(), true));
  await check(76, "notify.oos_threshold", equal(0.12), async () => {
    assert.equal(await page.getByRole("checkbox", { name: "新缺货达到阈值时" }).isChecked(), true);
    assert.equal(await page.getByRole("spinbutton", { name: "新缺货阈值百分比" }).inputValue(), "12");
  });
  await check(77, "notify.dingtalk_webhook", equal(values.notify.dingtalk_webhook),
    () => input("#si-dingtalk-webhook", values.notify.dingtalk_webhook));
  await page.getByRole("tab", { name: "Agent 平台" }).click();
  await check(78, "skill_platforms", (entries) => entries.some((entry) => entry.dir === values.skillDirectory),
    () => input('input[aria-label="新平台 Skill 目录"]', values.skillDirectory));
  await page.evaluate(() => { window.location.hash = "#/"; });
  await page.getByRole("button", { name: "添加已有项目" }).waitFor();
  await check(79, "extra_projects", (entries) => entries.includes(values.extraProject), () =>
    page.getByText("Synthetic extra project", { exact: true }).first().waitFor({ timeout: 12_000 }));
  await check(80, "hidden_projects", (entries) => entries.includes(values.hiddenProject), async () =>
    assert.equal(await page.getByText("Synthetic hidden project", { exact: true }).count(), 0));
  await check(81, "conflict_patterns", equal(values.conflict_patterns), null);
  return rows;
}
