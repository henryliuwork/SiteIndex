import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { assertPersisted } from "./report.mjs";
import { independentItem, editIndependentItem, readReadmeSection,
  verifyIndependentFile, verifyIndependentIpc } from "./independent-items.mjs";

const RULE_TITLE = "工作规则与偏好";
const TODO_ACTION = { 65: "status_changed", 66: "note_changed" };
const TODO_ISSUE = { url: "https://config.example.test/synthetic-page", rule: "title_missing",
  severity: "mid", detail: "Synthetic missing title", status: "open",
  first_seen: "2026-11-24", last_seen: "2026-11-24" };

export function hasTodoHistoryEvent(text, todoKey, id) {
  const entries = text.trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  return entries.some((entry) => entry.dedupe_key === todoKey && entry.action === TODO_ACTION[id]);
}

export function withoutRulesHeading(markdown) {
  return markdown.replace(/^## 工作规则与偏好\r?\n/mu, "");
}

function mismatch(message) {
  const error = new Error(message);
  error.acceptanceStatus = "assertion_failed";
  return error;
}

async function legacyReadmeFixture(profile, projectId) {
  const projectDir = path.join(profile.layout.projectRoot, projectId);
  const template = await readFile(path.join(profile.layout.installDir, "resources", "templates", "project", "README.md"), "utf8");
  if (!template.includes(`## ${RULE_TITLE}`)) throw new Error("Official baseline legacy README lacks rules heading");
  const index = path.join(projectDir, "index");
  await mkdir(index, { recursive: true });
  const job = { enabled: false, days: [], time: "00:00" };
  const config = { schema_version: "1.0", domain: "config.example.test", base_url: "https://config.example.test",
    platform: "woocommerce", currency: "USD", locale: "en-US", timezone: "UTC", markets: ["US"],
    brand: { name: "Synthetic Legacy Project", tagline: "Synthetic acceptance fixture" },
    sitemaps: [], crawl: { adapter: "gmc_feed", feed_url: [], rate_limit_ms: 200 },
    categories: { mode: "feed" }, workspace_folders: [],
    schedule: { daily: { ...job }, validate: { ...job }, weekly: { ...job }, readme: { ...job },
      monthly: { ...job, day_of_month: 1 },
      options: { wake_to_run: false, run_if_missed: false, notify_on_failure: false, validate_after_sync: false } } };
  await writeFile(path.join(index, "site.json"), `${JSON.stringify(config, null, 2)}\n`);
  await writeFile(path.join(projectDir, "README.md"), template);
  return projectDir;
}

export function independentAdapter(id) {
  const item = independentItem(id);
  const projectId = `synthetic-independent-${id}`;
  const workspaceId = "synthetic-workspace-missing-rules";
  let todoKey;
  let runnerDeviceId;
  let baselineBytes;
  let historyBytes;
  let workspaceFile;
  let workspaceExpected;
  const projectDir = (profile) => path.join(profile.layout.projectRoot, projectId);
  const targetFile = (profile) => item.kind === "runner"
    ? path.join(projectDir(profile), "_site-index", ".runner.json")
    : item.kind === "readme" ? path.join(projectDir(profile), "README.md")
      : path.join(projectDir(profile), "_site-index", "todos", "manual-state.jsonl");
  const historyFile = (profile) => path.join(projectDir(profile), "_site-index", "todos", "history.jsonl");
  const navigate = async (page, project = projectId) => {
    const route = item.kind === "runner" ? "runs" : item.kind === "readme" ? "readme" : "todos";
    await page.evaluate(({ id: target, tail }) => { window.location.hash = `#/p/${target}/${tail}`; },
      { id: project, tail: route });
    if (item.kind === "todo") await page.getByRole("searchbox", { name: "搜索项目待办" }).waitFor();
    else await page.getByRole("heading", { name: item.kind === "runner" ? "定时计划" : "用户区块" }).waitFor();
  };
  const fileReadback = (profile) => verifyIndependentFile(item, targetFile(profile), todoKey);
  const ipcReadback = (page) => verifyIndependentIpc(item, page, projectId, todoKey, runnerDeviceId);
  return {
    async baselineUi({ page, profile, noteIpc }) {
      noteIpc({ operation: "settings.set", itemId: id, fields: ["projects_root", "close_to_tray"] });
      await page.evaluate((root) => window.siteindex.settings.set({ projects_root: root, close_to_tray: false }),
        profile.layout.projectRoot);
      let created;
      if (id === 64) {
        const directory = await legacyReadmeFixture(profile, projectId);
        noteIpc({ operation: "projects.addExisting", itemId: id });
        created = await page.evaluate((location) => window.siteindex.projects.addExisting(location), directory);
      } else {
        noteIpc({ operation: "projects.createWorkspaceOnly", itemId: id });
        created = await page.evaluate((input) => window.siteindex.projects.createWorkspaceOnly(input), {
          url: "https://config.example.test", brand: { name: "Synthetic Config Project" }, markets: ["US"],
          projects_root: profile.layout.projectRoot, folder_name: projectId,
          workspace: { enabled: true, platform: "woocommerce", esp_presets: [] },
        });
      }
      if (created.id !== projectId) throw new Error(`Synthetic independent project ${id} was not created`);
      if (id >= 65) {
        const issuePath = path.join(projectDir(profile), "_site-index", "seo", "issues.jsonl");
        await mkdir(path.dirname(issuePath), { recursive: true });
        await writeFile(issuePath, `${JSON.stringify(TODO_ISSUE)}\n`);
      }
      await navigate(page);
      noteIpc({ operation: item.kind === "runner" ? "runner.claim"
        : item.kind === "readme" ? "readme.saveUserBlocks" : "todos.update", itemId: id });
      try { ({ todoKey } = await editIndependentItem(page, item, projectId)); }
      catch (error) {
        if (/Timed out waiting for independent row .* (save|claim)/iu.test(error?.message ?? "")) {
          error.acceptanceStatus = "assertion_failed";
        }
        throw error;
      }
      if (id === 61) {
        const state = await page.evaluate((project) => window.siteindex.runner.get(project), projectId);
        runnerDeviceId = state.this_device.device_id;
      }
    },
    async verifyBaselineIpc({ page, noteIpc }) {
      noteIpc({ operation: item.kind === "runner" ? "runner.get"
        : item.kind === "readme" ? "readme.get" : "todos.list", itemId: id });
      await ipcReadback(page);
    },
    async verifyBaselineFile({ profile }) {
      const evidence = await fileReadback(profile);
      runnerDeviceId = evidence.runnerDeviceId;
      baselineBytes = await readFile(targetFile(profile));
      if (id >= 65) {
        historyBytes = await readFile(historyFile(profile));
        if (!hasTodoHistoryEvent(historyBytes.toString("utf8"), todoKey, id)) {
          throw mismatch(`Row ${id} todo history event is missing`);
        }
      }
    },
    async candidateUi({ page, profile, noteIpc }) {
      if (!baselineBytes || !(await readFile(targetFile(profile))).equals(baselineBytes)) {
        throw mismatch(`Row ${id} value file changed during candidate overwrite`);
      }
      if (historyBytes && !(await readFile(historyFile(profile))).equals(historyBytes)) {
        throw mismatch(`Row ${id} todo history changed during candidate overwrite`);
      }
      await navigate(page);
      if (item.kind === "runner") {
        const state = await page.evaluate((project) => window.siteindex.runner.get(project), projectId);
        if (!state.is_this_device || await page.getByRole("button", { name: "改为本机" }).count()) {
          throw mismatch(`Row ${id} candidate UI lost the local runner state`);
        }
      } else if (item.kind === "readme") {
        if (id === 64) await page.getByRole("region", { name: "README 用户区块" })
          .getByRole("button", { name: "编辑", exact: true }).click();
        const title = { overview: "项目概况", focus: "当前重点", rules: RULE_TITLE }[item.block];
        if (await page.getByRole("textbox", { name: title }).inputValue() !== item.expected) {
          throw mismatch(`Row ${id} candidate UI lost the saved README text`);
        }
        if (id === 64) await page.getByRole("region", { name: "README 用户区块" })
          .getByRole("button", { name: "取消编辑" }).click();
      } else {
        const listed = await page.evaluate((project) => window.siteindex.todos.list(project), projectId);
        const finding = listed.items.find((entry) => entry.finding.dedupe_key === todoKey);
        if (!finding) throw mismatch(`Row ${id} todo finding is missing`);
        const escaped = finding.finding.title.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
        await page.getByRole("row", { name: new RegExp(escaped, "u") }).click();
        const actual = id === 65 ? await page.getByRole("combobox", { name: "更新待办状态" }).innerText()
          : await page.getByRole("textbox", { name: "编辑待办备注" }).inputValue();
        if (id === 65 ? !actual.includes("进行中") : actual !== item.expected) {
          throw mismatch(`Row ${id} candidate UI state differs from saved value`);
        }
      }
      if (id === 64) {
        workspaceExpected = "Candidate saved this synthetic workspace rule.";
        noteIpc({ operation: "projects.createWorkspaceOnly", itemId: id, mode: "missing-title-fixture" });
        const created = await page.evaluate((input) => window.siteindex.projects.createWorkspaceOnly(input), {
          url: "https://workspace.example.test", brand: { name: "Synthetic Workspace Project" }, markets: ["US"],
          projects_root: profile.layout.projectRoot, folder_name: workspaceId,
          workspace: { enabled: true, platform: "woocommerce", esp_presets: [] },
        });
        if (created.id !== workspaceId) throw new Error("Synthetic missing-title workspace was not created");
        workspaceFile = path.join(profile.layout.projectRoot, workspaceId, "README.md");
        const initial = await readFile(workspaceFile, "utf8");
        await writeFile(workspaceFile, withoutRulesHeading(initial));
        if (/^## 工作规则与偏好\s*$/mu.test(await readFile(workspaceFile, "utf8"))) {
          throw new Error("Missing-title synthetic fixture still has the rules heading");
        }
        await navigate(page, workspaceId);
        noteIpc({ operation: "readme.saveUserBlocks", itemId: id, mode: "missing-title-repair" });
        try { await editIndependentItem(page, { ...item, expected: workspaceExpected }, workspaceId); }
        catch (error) {
          if (/Timed out waiting for independent row .* save/iu.test(error?.message ?? "")) {
            error.acceptanceStatus = "assertion_failed";
          }
          throw error;
        }
      }
    },
    async verifyCandidateIpc({ page, noteIpc }) {
      noteIpc({ operation: item.kind === "runner" ? "runner.get"
        : item.kind === "readme" ? "readme.get" : "todos.list", itemId: id });
      await ipcReadback(page);
      if (workspaceFile) {
        assertPersisted((await page.evaluate((project) => window.siteindex.readme.get(project), workspaceId))
          .user_blocks.rules, workspaceExpected);
      }
    },
    async verifyCandidateFile({ profile }) {
      await fileReadback(profile);
      if (!(await readFile(targetFile(profile))).equals(baselineBytes)) {
        throw mismatch(`Row ${id} candidate file no longer matches baseline bytes`);
      }
      if (historyBytes && !(await readFile(historyFile(profile))).equals(historyBytes)) {
        throw mismatch(`Row ${id} candidate todo history no longer matches baseline bytes`);
      }
      if (workspaceFile) {
        const markdown = await readFile(workspaceFile, "utf8");
        assertPersisted(readReadmeSection(markdown, RULE_TITLE), workspaceExpected);
      }
    },
  };
}

export function independentHandlers(ids) {
  return Object.fromEntries(ids.map((id) => [id, independentAdapter(id)]));
}
