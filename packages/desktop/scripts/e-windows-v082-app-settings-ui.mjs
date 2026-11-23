/** Packaged v0.8.0 UI actions; all values and paths are synthetic runner-local data. */
export async function exerciseBaselineAppSettings(page, values) {
  const rows = [];
  let activeTab = "基本信息";
  let inSettings = true;
  const reloadSettings = async () => {
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("#si-device-name").waitFor();
    if (activeTab !== "基本信息") await page.getByRole("tab", { name: activeTab }).click();
  };
  const record = async (ids, action, verify) => {
    try {
      await action();
      await page.waitForFunction(async ({ paths }) => {
        const settings = await window.siteindex.settings.get();
        return paths.every(([key, expected]) => {
          const actual = key.split(".").reduce((part, segment) => part?.[segment], settings);
          return JSON.stringify(actual) === JSON.stringify(expected);
        });
      }, { paths: verify }, { timeout: 12_000 });
      if (inSettings) {
        await page.getByText("正在保存软件设置…").waitFor({ state: "hidden", timeout: 12_000 });
        await reloadSettings();
      }
      for (const id of ids) rows.push({ id, status: "passed", evidence: "baseline packaged UI save + IPC readback" });
    } catch (error) {
      for (const id of ids) rows.push({ id, status: "failed", evidence: "baseline packaged UI save/readback failed",
        errorType: error?.name ?? "Error" });
      if (inSettings) await reloadSettings();
    }
  };
  const blur = async (selector, value) => {
    await page.locator(selector).fill(value);
    await page.locator(selector).press("Tab");
  };
  const tab = async (name) => { await page.getByRole("tab", { name }).click(); activeTab = name; };

  await page.evaluate(() => { window.location.hash = "#/settings"; });
  await page.locator("#si-device-name").waitFor();
  await record([67], () => blur("#si-projects-root", values.projects_root), [["projects_root", values.projects_root]]);
  await record([68], () => blur("#si-device-name", values.device_name), [["device_name", values.device_name]]);
  await record([69], () => blur("#si-cache-dir", values.cache_dir), [["cache_dir", values.cache_dir]]);
  await record([70], () => page.getByRole("checkbox", { name: "关闭窗口时最小化到托盘" }).uncheck(),
    [["close_to_tray", false]]);
  await record([71], () => page.getByRole("checkbox", { name: "开机时启动 SiteIndex" }).check(),
    [["launch_at_login", true]]);

  await tab("浏览器与命令行");
  await record([72, 73], () => blur("#si-browser-path", values.browser.executable_path),
    [["browser.channel", "custom"], ["browser.executable_path", values.browser.executable_path]]);

  await tab("通知");
  await record([74], () => page.getByRole("checkbox", { name: "失败时", exact: true }).uncheck(),
    [["notify.on_failure", false]]);
  await record([75], () => page.getByRole("checkbox", { name: "成功时", exact: true }).check(),
    [["notify.on_success", true]]);
  await record([76], async () => {
    await page.getByRole("checkbox", { name: "新缺货达到阈值时" }).check();
    await page.getByRole("spinbutton", { name: "新缺货阈值百分比" }).fill("12");
    await page.getByRole("spinbutton", { name: "新缺货阈值百分比" }).press("Tab");
  }, [["notify.oos_threshold", 0.12]]);
  await record([77], () => blur("#si-dingtalk-webhook", values.notify.dingtalk_webhook),
    [["notify.dingtalk_webhook", values.notify.dingtalk_webhook]]);

  await tab("Agent 平台");
  try {
    await page.getByRole("button", { name: "添加平台目录" }).click();
    const input = page.getByRole("textbox", { name: "新平台 Skill 目录" }).last();
    await input.fill(values.skillDirectory);
    await input.press("Tab");
    await page.waitForFunction(async (directory) => {
      const settings = await window.siteindex.settings.get();
      return settings.skill_platforms.some((entry) => entry.dir === directory);
    }, values.skillDirectory, { timeout: 12_000 });
    await page.getByText("正在保存软件设置…").waitFor({ state: "hidden", timeout: 12_000 });
    rows.push({ id: 78, status: "passed", evidence: "baseline packaged UI save + IPC readback" });
  } catch (error) {
    rows.push({ id: 78, status: "failed", evidence: "baseline packaged UI save/readback failed",
      errorType: error?.name ?? "Error" });
  }

  await page.evaluate(() => { window.location.hash = "#/"; });
  inSettings = false;
  await page.getByRole("button", { name: "添加已有项目" }).waitFor();
  await record([79], async () => {
    await page.getByRole("button", { name: "添加已有项目" }).click();
    await page.locator("#existing-project-path").fill(values.extraProject);
    await page.getByRole("dialog").getByRole("button", { name: "添加项目", exact: true }).click();
  }, [["extra_projects", [values.extraProject]]]);
  await record([80], async () => {
    await page.getByRole("button", { name: "Synthetic hidden project更多操作" }).click();
    await page.getByRole("button", { name: "移除项目", exact: true }).first().click();
    await page.getByRole("dialog").getByRole("button", { name: "移除项目", exact: true }).click();
  }, [["hidden_projects", [values.hiddenProject]]]);

  rows.push({ id: 81, status: "pending-api", evidence: "no UI; settings.set/get and file readback in harness" });
  await page.evaluate(() => { window.location.hash = "#/settings"; });
  await page.locator("#si-device-name").waitFor();
  const vault = await page.evaluate((origin) => window.siteindexWindow?.wordpressCredentials?.status(origin), values.wpOrigin);
  if (vault?.state === "unavailable") {
    rows.push({ id: 82, status: "unverified", evidence: "runner OS safe storage unavailable; no credential submitted" });
  } else {
    let credentialStage = "target-button";
    try {
      await page.getByRole("heading", { name: "WordPress 图片托管凭据" }).waitFor();
      await page.getByRole("button", { name: "配置凭据" }).first().click();
      credentialStage = "credential-form";
      await page.locator("#si-wp-username").fill("fixture-only-user");
      await page.locator("#si-wp-application-password").fill("fixture-only-password");
      credentialStage = "save-status";
      await page.getByRole("button", { name: "保存到本机" }).click();
      await page.waitForFunction(async (origin) =>
        (await window.siteindexWindow?.wordpressCredentials?.status(origin))?.state === "configured",
      values.wpOrigin, { timeout: 12_000 });
      rows.push({ id: 82, status: "passed", evidence: "baseline packaged UI save + vault status only" });
    } catch (error) {
      rows.push({ id: 82, status: "failed", evidence: "baseline packaged credential UI/status failed",
        errorType: error?.name ?? "Error", stage: credentialStage });
    }
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
