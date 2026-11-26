import path from "node:path";
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { waitForObserved } from "./session.mjs";
import { projectConfigItem, editProjectConfigItem,
  verifyProjectConfigFile, verifyProjectConfigIpc } from "./project-config-items.mjs";
import { advancedConfigItem, editAdvancedConfigItem,
  verifyAdvancedConfigFile, verifyAdvancedConfigIpc } from "./project-config-advanced-items.mjs";

function mismatch(message) {
  const error = new Error(message);
  error.acceptanceStatus = "assertion_failed";
  return error;
}

function containsOriginal(actual, original) {
  if (Array.isArray(original)) return isDeepStrictEqual(actual, original);
  if (original && typeof original === "object") {
    return actual && typeof actual === "object" && Object.entries(original)
      .every(([key, value]) => containsOriginal(actual[key], value));
  }
  return isDeepStrictEqual(actual, original);
}

function setAt(source, key, value) {
  const parts = key.split(".");
  const section = parts.slice(0, -1).reduce((entry, part) => entry[part], source);
  section[parts.at(-1)] = value;
}

function itemApi(id) {
  if (id >= 1 && id <= 20) return {
    item: projectConfigItem(id), edit: editProjectConfigItem,
    file: verifyProjectConfigFile, ipc: verifyProjectConfigIpc,
  };
  if (id >= 21 && id <= 45) return {
    item: advancedConfigItem(id), edit: editAdvancedConfigItem,
    file: verifyAdvancedConfigFile, ipc: verifyAdvancedConfigIpc,
  };
  throw new Error(`Project config adapter has no matrix row ${id}`);
}

/** Each returned adapter is used in one fresh profile for exactly one matrix row. */
export function projectConfigAdapter(id) {
  const api = itemApi(id);
  const projectId = `synthetic-config-${id}`;
  let baselineBytes;
  let baselineConfig;
  let jsonExpected;
  const siteFile = (profile) => path.join(profile.layout.projectRoot, projectId, "_site-index", "site.json");
  const navigate = async (page) => {
    await page.evaluate((project) => { window.location.hash = `#/p/${project}/settings/config`; }, projectId);
    await page.getByRole("button", { name: "保存配置", exact: true }).waitFor();
  };
  const verifyFile = async (profile) => api.file(api.item, siteFile(profile));
  const verifyIpc = async (page) => api.ipc(api.item, page, projectId);
  return {
    async baselineUi({ page, profile, noteIpc }) {
      await page.evaluate(() => { window.location.hash = "#/settings"; });
      const closeToTray = page.getByRole("checkbox", { name: "关闭窗口时最小化到托盘" });
      await closeToTray.waitFor();
      if (await closeToTray.isChecked()) {
        await closeToTray.uncheck();
        noteIpc({ operation: "settings.get", itemId: id });
        await waitForObserved(async () => !(await page.evaluate(() => window.siteindex.settings.get())).close_to_tray,
          { label: `row ${id} normal-exit setting` });
      }
      noteIpc({ operation: "projects.createWorkspaceOnly", itemId: id });
      const created = await page.evaluate((input) => window.siteindex.projects.createWorkspaceOnly(input), {
        url: "https://config.example.test", brand: { name: "Synthetic Config Project" }, markets: ["US"],
        projects_root: profile.layout.projectRoot, folder_name: projectId,
        workspace: { enabled: true, platform: "woocommerce", esp_presets: [] },
      });
      if (created.id !== projectId) throw new Error(`Synthetic project ${id} was not created`);
      if (id === 1) {
        jsonExpected = JSON.parse(await readFile(siteFile(profile), "utf8"));
        setAt(jsonExpected, api.item.path, api.item.expected);
      }
      await navigate(page);
      noteIpc({ operation: "projects.updateConfig", itemId: id });
      try { await api.edit(page, api.item, projectId); }
      catch (error) {
        if (/Timed out waiting for .* saved via IPC/iu.test(error?.message ?? "")) {
          error.acceptanceStatus = "assertion_failed";
        }
        throw error;
      }
    },
    async verifyBaselineIpc({ page, noteIpc }) {
      noteIpc({ operation: "projects.get", itemId: id });
      await verifyIpc(page);
    },
    async verifyBaselineFile({ profile }) {
      await verifyFile(profile);
      baselineBytes = await readFile(siteFile(profile));
      baselineConfig = JSON.parse(baselineBytes.toString("utf8"));
      if (jsonExpected && !containsOriginal(baselineConfig, jsonExpected)) {
        throw mismatch("JSON editor lost a pre-existing config field");
      }
    },
    async candidateUi({ page, profile, noteIpc }) {
      if (!baselineBytes) throw new Error("Baseline file snapshot is missing");
      const currentBytes = await readFile(siteFile(profile));
      if (!currentBytes.equals(baselineBytes)) throw mismatch(`Candidate startup rewrote row ${id} config file`);
      await navigate(page);
      noteIpc({ operation: "projects.updateConfig", itemId: id, mode: "no-op" });
      await page.getByRole("button", { name: "保存配置", exact: true }).click();
      try {
        await waitForObserved(async () => (await page.getByRole("status").allTextContents())
          .some((message) => message.includes("配置已保存。")),
        { timeoutMs: 20_000, label: `row ${id} no-op save result` });
      } catch (error) {
        error.acceptanceStatus = "assertion_failed";
        throw error;
      }
      if (!(await readFile(siteFile(profile))).equals(baselineBytes)) {
        throw mismatch(`Candidate no-op save rewrote row ${id} config file`);
      }
    },
    async verifyCandidateIpc({ page, noteIpc }) {
      noteIpc({ operation: "projects.get", itemId: id });
      await verifyIpc(page);
      const current = (await page.evaluate((project) => window.siteindex.projects.get(project), projectId)).config;
      if (!containsOriginal(current, baselineConfig)) throw mismatch(`Candidate IPC lost row ${id} baseline config`);
    },
    async verifyCandidateFile({ profile }) {
      await verifyFile(profile);
      const current = JSON.parse(await readFile(siteFile(profile), "utf8"));
      if (!containsOriginal(current, baselineConfig)) throw mismatch(`Candidate file lost row ${id} baseline config`);
    },
  };
}

export function projectConfigHandlers(ids) {
  return Object.fromEntries(ids.map((id) => [id, projectConfigAdapter(id)]));
}
