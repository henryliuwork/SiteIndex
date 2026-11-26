import { spawnSync } from "node:child_process";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { appSettingsItem, editAppSettingsItem, verifyAppSettingsFile, verifyAppSettingsIpc } from "./app-settings-items.mjs";
import { assertPersisted } from "./report.mjs";
import { waitForObserved } from "./session.mjs";

const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const valueAt = (source, key) => key.split(".").reduce((part, segment) => part?.[segment], source);

function failed(message) {
  const error = new Error(message);
  error.acceptanceStatus = "assertion_failed";
  return error;
}

export function appSettingsValues(profile) {
  return {
    projects_root: profile.layout.projectRoot,
    device_name: "Synthetic acceptance desktop",
    cache_dir: path.join(profile.root, "cache"),
    browser: { executable_path: path.join(profile.root, "fake-browser.example.test.exe") },
    notify: { dingtalk_webhook: "https://webhook.example.test/synthetic-only" },
    skillDirectory: path.join(profile.root, "agent-skills.example.test"),
    extraProject: path.join(profile.root, "extra-project.example.test"),
    hiddenProject: path.join(profile.layout.projectRoot, "hidden-project.example.test"),
    hiddenProjectName: "Synthetic hidden project",
    conflict_patterns: ["synthetic-conflict-pattern"],
  };
}

export function startupEntries(executable, run = spawnSync) {
  const result = run("reg.exe", ["query", RUN_KEY],
    { encoding: "utf8", windowsHide: true, timeout: 10_000 });
  if (result.error) throw new Error("Windows startup registry query failed");
  if (result.status === 1 && /unable to find|cannot find|找不到/iu.test(`${result.stdout}\n${result.stderr}`)) return [];
  if (result.status !== 0) throw new Error("Windows startup registry query failed");
  return result.stdout.split(/\r?\n/u)
    .map((line) => line.match(/^\s*(\S+)\s+REG_(\w+)\s+(.+)\s*$/u))
    .filter(Boolean)
    .map((match) => ({ name: match[1], value: match[3].trim() }))
    .filter((entry) => entry.value.toLowerCase().includes(executable.toLowerCase()));
}

async function createExtraProject(directory) {
  await mkdir(path.join(directory, "index"), { recursive: true });
  const job = { enabled: false, days: [], time: "00:00" };
  const config = { schema_version: "1.0", domain: "extra.example.test", base_url: "https://extra.example.test",
    platform: "woocommerce", currency: "USD", locale: "en-US", timezone: "UTC", markets: ["US"],
    brand: { name: "Synthetic extra project", tagline: "Synthetic acceptance fixture" },
    sitemaps: [], crawl: { adapter: "gmc_feed", feed_url: [], rate_limit_ms: 200 },
    categories: { mode: "feed" }, workspace_folders: [],
    schedule: { daily: { ...job }, validate: { ...job }, weekly: { ...job }, readme: { ...job },
      monthly: { ...job, day_of_month: 1 },
      options: { wake_to_run: false, run_if_missed: false, notify_on_failure: false, validate_after_sync: false } } };
  await writeFile(path.join(directory, "index", "site.json"), `${JSON.stringify(config, null, 2)}\n`);
  await writeFile(path.join(directory, "README.md"), "# Synthetic extra project\n");
}

async function createHiddenProject(page, values) {
  const created = await page.evaluate((input) => window.siteindex.projects.createWorkspaceOnly(input), {
    url: "https://hidden.example.test", brand: { name: "Synthetic hidden project" }, markets: ["US"],
    projects_root: values.projects_root, folder_name: path.basename(values.hiddenProject),
    workspace: { enabled: true, platform: "woocommerce", esp_presets: [] },
  });
  if (created.id !== path.basename(values.hiddenProject)) throw new Error("Synthetic hidden project was not created");
}

async function navigate(page, id) {
  await page.evaluate((route) => { window.location.hash = route; }, id === 79 || id === 80 ? "#/" : "#/settings");
  if (id === 79 || id === 80) await page.getByRole("button", { name: "添加已有项目" }).waitFor();
  else await page.getByRole("tab", { name: "基本信息" }).waitFor();
}

export async function checkVisible(page, item, values) {
  if (item.id === 79) {
    await page.getByRole("link", { name: "Synthetic extra project", exact: true }).waitFor({ state: "visible" });
    const projects = await page.evaluate(() => window.siteindex.projects.list());
    if (!projects.some((project) => project.name === "Synthetic extra project")) {
      throw failed("Row 79 candidate projects.list lost the added project");
    }
  } else if (item.id === 80) {
    await page.getByRole("region", { name: "项目列表" }).waitFor();
    if (await page.getByRole("link", { name: "Synthetic hidden project", exact: true }).count()) {
      throw failed("Row 80 candidate still displays the hidden project");
    }
  } else if (item.id === 81) {
    return; // No UI control exists for this setting.
  } else {
    const tab = { environment: "浏览器与命令行", notifications: "通知", skills: "Agent 平台" }[item.tab];
    if (tab) await page.getByRole("tab", { name: tab }).click();
    if (item.kind === "checkbox") {
      assertPersisted(await page.getByRole("checkbox", { name: item.name, exact: true }).isChecked(), item.expected);
    } else if (item.kind === "threshold") {
      assertPersisted(await page.getByRole("spinbutton", { name: "新缺货阈值百分比" }).inputValue(), "17");
    } else if (item.kind === "platform") {
      assertPersisted(await page.getByRole("textbox", { name: "新平台 Skill 目录" }).last().inputValue(), item.expected);
    } else if (item.kind === "webhook") {
      await page.getByRole("button", { name: "发送测试" }).focus();
      await page.keyboard.press("Shift+Tab");
      const matches = await page.evaluate((expected) => {
        const input = document.activeElement;
        return input instanceof HTMLInputElement && input.type === "password"
          && [...(input.labels ?? [])].some((label) => label.textContent?.trim() === "钉钉机器人 Webhook")
          && input.value === expected;
      }, item.expected);
      if (!matches) throw failed("Row 77 candidate masked webhook UI value differs from saved setting");
    } else {
      const name = item.kind === "browser" ? "自定义路径" : item.name;
      assertPersisted(await page.getByRole("textbox", { name }).inputValue(),
        item.kind === "browser" ? values.browser.executable_path : item.expected);
    }
  }
}

/** One official baseline process, overwrite and fresh candidate process per matrix row. */
export function appSettingsAdapter(id) {
  if (id < 67 || id > 81) throw new Error(`Unsupported application setting row ${id}`);
  let values;
  let item;
  let savedBytes;
  let startupBefore;
  const settingsFile = (profile) => path.join(profile.layout.appDataRoot, "SiteIndex", "settings.json");
  const executable = (profile) => path.join(profile.layout.installDir, "SiteIndex.exe");
  const registryReadback = (profile) => {
    if (id !== 71) return;
    if (startupEntries(executable(profile)).length === 0) throw failed("Row 71 Windows startup item was not registered");
  };
  const ipcReadback = async (page) => {
    await verifyAppSettingsIpc(item, page);
    if (id === 79 || id === 80) {
      const projects = await page.evaluate(() => window.siteindex.projects.list());
      const present = projects.some((project) => project.name === (id === 79
        ? "Synthetic extra project" : "Synthetic hidden project"));
      if (present !== (id === 79)) throw failed(`Row ${id} projects.list membership differs from saved setting`);
    }
  };
  return {
    async baselineUi({ page, profile, noteIpc }) {
      values = appSettingsValues(profile);
      item = appSettingsItem(id, values);
      if (id === 71) {
        startupBefore = startupEntries(executable(profile));
        if (startupBefore.length) throw new Error("Hosted runner already has this install path in Windows startup");
      }
      if (id !== 67 && id !== 71) {
        noteIpc({ operation: "settings.set", itemId: id, fields: ["projects_root", "close_to_tray"] });
        await page.evaluate((root) => window.siteindex.settings.set({ projects_root: root, close_to_tray: false }),
          values.projects_root);
      }
      if (id === 79) await createExtraProject(values.extraProject);
      if (id === 80) await createHiddenProject(page, values);
      await navigate(page, id);
      noteIpc({ operation: id === 79 ? "projects.addExisting" : id === 80 ? "projects.remove"
        : "settings.set", itemId: id, field: item.path });
      try { await editAppSettingsItem(page, item, values); }
      catch (error) {
        if (/Timed out waiting for app setting row .* IPC save/iu.test(error?.message ?? "")) {
          error.acceptanceStatus = "assertion_failed";
        }
        throw error;
      }
      registryReadback(profile);
    },
    async verifyBaselineIpc({ page, profile, noteIpc }) {
      noteIpc({ operation: id === 79 || id === 80 ? "projects.list" : "settings.get", itemId: id });
      await ipcReadback(page);
      registryReadback(profile);
    },
    async verifyBaselineFile({ profile }) {
      await verifyAppSettingsFile(item, settingsFile(profile));
      savedBytes = await readFile(settingsFile(profile));
      registryReadback(profile);
    },
    async candidateUi({ page, profile }) {
      if (!savedBytes || !(await readFile(settingsFile(profile))).equals(savedBytes)) {
        throw failed(`Row ${id} settings bytes changed during candidate overwrite`);
      }
      await navigate(page, id);
      await checkVisible(page, item, values);
      registryReadback(profile);
    },
    async verifyCandidateIpc({ page, profile, noteIpc }) {
      noteIpc({ operation: id === 79 || id === 80 ? "projects.list" : "settings.get", itemId: id });
      await ipcReadback(page);
      registryReadback(profile);
    },
    async verifyCandidateFile({ profile }) {
      await verifyAppSettingsFile(item, settingsFile(profile));
      if (!(await readFile(settingsFile(profile))).equals(savedBytes)) {
        throw failed(`Row ${id} candidate startup rewrote settings bytes`);
      }
      registryReadback(profile);
    },
    ...(id === 71 ? { async cleanupSystem({ page, profile, noteIpc }) {
      noteIpc({ operation: "settings.set", itemId: id, mode: "restore-startup" });
      await page.evaluate(() => window.siteindex.settings.set({ launch_at_login: false }));
      await waitForObserved(() => startupEntries(executable(profile)).length === 0,
        { label: "synthetic Windows startup item removal" });
      if (startupBefore?.length !== 0) throw new Error("Windows startup baseline was not clean");
    } } : {}),
  };
}

export function appSettingsHandlers(ids) {
  return Object.fromEntries(ids.map((id) => [id, appSettingsAdapter(id)]));
}
