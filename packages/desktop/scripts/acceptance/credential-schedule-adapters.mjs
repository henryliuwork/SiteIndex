import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { credentialStateEvidence, editCredentialItem, editScheduleItem,
  SCHEDULE_JOBS, verifyScheduleFile, verifyScheduleIpc, verifySystemSetting } from "./app-settings-items.mjs";
import { assertPersisted } from "./report.mjs";
import { waitForObserved } from "./session.mjs";

const CREDENTIAL_ORIGIN = "https://credential.example.test";
const CREDENTIAL_PROJECT = "synthetic-credential-project";
const SCHEDULE_PROJECT = "synthetic-task83-project";
const taskName = (job) => `\\SiteIndex\\${SCHEDULE_PROJECT}-${job}`;

function failed(message) {
  const error = new Error(message);
  error.acceptanceStatus = "assertion_failed";
  return error;
}

function harness(message) {
  const error = new Error(message);
  error.acceptanceStatus = "harness_error";
  return error;
}

const fileExists = (file) => stat(file).then(() => true, (error) => {
  if (error?.code === "ENOENT") return false;
  throw error;
});

function vaultFile(profile) {
  // The synthetic origin is hashed only to resolve the vault filename; never include it in evidence.
  const fingerprint = createHash("sha256").update(CREDENTIAL_ORIGIN).digest("hex");
  return path.join(profile.layout.vaultPath, `wordpress-${fingerprint}.vault.json`);
}

async function createWorkspace(page, profile, id, origin) {
  const created = await page.evaluate((input) => window.siteindex.projects.createWorkspaceOnly(input), {
    url: origin, brand: { name: id === CREDENTIAL_PROJECT ? "Synthetic credential project" : "Synthetic scheduled project" },
    markets: ["US"], projects_root: profile.layout.projectRoot, folder_name: id,
    workspace: { enabled: true, platform: "woocommerce", esp_presets: [] },
  });
  if (created.id !== id) throw new Error("Synthetic acceptance workspace was not created");
}

async function navigate(page, route, label) {
  await page.evaluate((hash) => { window.location.hash = hash; }, route);
  await page.getByRole("heading", { name: label }).waitFor();
}

/** #82 reports only the state enum, secure-storage availability and encrypted-file existence. */
export function credentialAdapter({ username, applicationPassword }) {
  if (!username || !applicationPassword) throw new Error("Runtime synthetic credentials are required");
  let profileVault;
  let lastState;
  const statusReadback = async (page) => {
    const state = await credentialStateEvidence(page, CREDENTIAL_ORIGIN, profileVault);
    assertPersisted(state, { state: "configured", safeStorageAvailable: true, encryptedFileExists: true });
    lastState = state;
    return state;
  };
  return {
    reportEvidence: () => lastState,
    async baselineUi({ page, profile, noteIpc }) {
      profileVault = vaultFile(profile);
      noteIpc({ operation: "settings.set", itemId: 82, fields: ["projects_root", "close_to_tray"] });
      await page.evaluate((root) => window.siteindex.settings.set({ projects_root: root, close_to_tray: false }),
        profile.layout.projectRoot);
      await createWorkspace(page, profile, CREDENTIAL_PROJECT, CREDENTIAL_ORIGIN);
      noteIpc({ operation: "projects.updateConfig", itemId: 82, field: "edm.image_host.type" });
      await page.evaluate((id) => window.siteindex.projects.updateConfig(id,
        { edm: { image_host: { type: "wordpress" } } }), CREDENTIAL_PROJECT);
      if (await fileExists(profileVault)) throw new Error("Synthetic credential vault already exists");
      await navigate(page, "#/settings", "WordPress 图片托管凭据");
      noteIpc({ operation: "wordpressCredentials.save", itemId: 82, fields: ["siteUrl", "username", "applicationPassword"] });
      try { await editCredentialItem(page, CREDENTIAL_ORIGIN, username, applicationPassword); }
      catch (error) {
        if (/credential status after UI save/iu.test(error?.message ?? "")) error.acceptanceStatus = "assertion_failed";
        throw error;
      }
    },
    async verifyBaselineIpc({ page, noteIpc }) {
      noteIpc({ operation: "wordpressCredentials.status", itemId: 82 });
      await statusReadback(page);
    },
    async verifyBaselineFile() {
      if (!await fileExists(profileVault)) throw failed("Row 82 encrypted vault was not saved");
    },
    async candidateUi({ page }) {
      await navigate(page, "#/settings", "WordPress 图片托管凭据");
      const region = page.getByRole("region", { name: `凭据：${CREDENTIAL_ORIGIN}` });
      await region.getByText("本机凭据已保存", { exact: true }).waitFor();
      await region.getByRole("button", { name: "替换凭据" }).waitFor();
    },
    async verifyCandidateIpc({ page, noteIpc }) {
      noteIpc({ operation: "wordpressCredentials.status", itemId: 82 });
      await statusReadback(page);
    },
    async verifyCandidateFile() {
      if (!await fileExists(profileVault)) throw failed("Row 82 encrypted vault vanished after upgrade");
    },
  };
}

export function readSystemTask(job, run = spawnSync) {
  if (!SCHEDULE_JOBS.includes(job)) throw new Error("Unknown synthetic schedule task");
  const script = [
    "$ErrorActionPreference='Stop'",
    "$raw = & schtasks.exe /Query /TN $env:SITEINDEX_TASK_NAME /XML 2>&1 | Out-String",
    "if ($LASTEXITCODE -ne 0) { throw 'Task Scheduler query failed' }",
    "[xml]$doc=$raw",
    "$pick={ param($name) $node=$doc.SelectSingleNode(\"//*[local-name()='$name']\"); if ($node) { $node.InnerText } else { $null } }",
    "$trigger=$doc.SelectSingleNode(\"//*[local-name()='CalendarTrigger']\")",
    "$week=@($doc.SelectNodes(\"//*[local-name()='DaysOfWeek']/*\") | ForEach-Object { $_.LocalName })",
    "$month=@($doc.SelectNodes(\"//*[local-name()='DaysOfMonth']/*[local-name()='Day']\") | ForEach-Object { $_.InnerText })",
    "$enabled=$trigger.SelectSingleNode(\"*[local-name()='Enabled']\")",
    "$isEnabled=if($enabled){$enabled.InnerText}else{'true'}",
    "[pscustomobject]@{ command=& $pick 'Command'; arguments=& $pick 'Arguments'; workingDirectory=& $pick 'WorkingDirectory'; startBoundary=& $pick 'StartBoundary'; triggerCount=$doc.SelectNodes(\"//*[local-name()='Triggers']/*\").Count; actionCount=$doc.SelectNodes(\"//*[local-name()='Actions']/*\").Count; enabled=$isEnabled; week=$week; month=$month } | ConvertTo-Json -Compress -Depth 5",
  ].join("; ");
  const result = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8", windowsHide: true, timeout: 20_000,
    env: { ...process.env, SITEINDEX_TASK_NAME: taskName(job) },
  });
  if (result.error) throw harness("Task Scheduler XML query could not start");
  if (result.status !== 0) throw harness(`Synthetic task ${job} XML query failed`);
  let value;
  try { value = JSON.parse(result.stdout); }
  catch { throw harness(`Synthetic task ${job} XML parser failed`); }
  return { job, registered: true, xmlReadable: true, command: value.command,
    arguments: value.arguments, workingDirectory: value.workingDirectory,
    time: value.startBoundary?.slice(11, 16), weekdays: Array.isArray(value.week) ? value.week : [value.week].filter(Boolean),
    monthDay: Array.isArray(value.month) ? value.month[0] : value.month, triggerCount: value.triggerCount,
    actionCount: value.actionCount, enabled: value.enabled !== "false" };
}

export function taskAbsent(job, run = spawnSync) {
  const result = run("schtasks.exe", ["/Query", "/TN", taskName(job), "/XML"],
    { encoding: "utf8", windowsHide: true, timeout: 20_000 });
  if (result.error) throw harness("Task Scheduler absence query could not start");
  if (result.status === 0) return false;
  if (result.status === 1 && /cannot find|does not exist|not found|找不到|不存在/iu
    .test(`${result.stdout}\n${result.stderr}`)) return true;
  throw harness("Task Scheduler absence query failed");
}

function removeOwnedTask(job, run = spawnSync) {
  if (taskAbsent(job, run)) return;
  const result = run("schtasks.exe", ["/Delete", "/TN", taskName(job), "/F"],
    { encoding: "utf8", windowsHide: true, timeout: 20_000 });
  if (result.error || result.status !== 0 || !taskAbsent(job, run)) {
    throw new Error("Synthetic Windows schedule task cleanup failed");
  }
}

async function systemReadback(page, profile) {
  const tasks = await page.evaluate((id) => window.siteindex.schedule.listSystemTasks()
    .then((rows) => rows.filter((row) => row.projectId === id)), SCHEDULE_PROJECT);
  if (tasks.length !== SCHEDULE_JOBS.length || !SCHEDULE_JOBS.every((job) =>
    tasks.some((task) => task.taskName.toLowerCase() === taskName(job).toLowerCase()))) {
    throw failed("Row 83 packaged IPC did not list all five system tasks");
  }
  const projectPath = path.join(profile.layout.projectRoot, SCHEDULE_PROJECT);
  verifySystemSetting({ id: 83, systemState: true }, {
    tasks: SCHEDULE_JOBS.map((job) => readSystemTask(job)),
    executable: path.join(profile.layout.installDir, "SiteIndex.exe"), projectPath,
  });
}

/** #83 has no D18/D19 schedule.verify exemption; five real tasks and XML must pass. */
export function scheduleAdapter() {
  let siteFile;
  let baselineBytes;
  let created = false;
  const verifyIpc = async (page, profile) => {
    try { await waitForObserved(async () => {
      const state = await page.evaluate((id) => window.siteindex.schedule.verify(id), SCHEDULE_PROJECT);
      return state.state === "ok" && SCHEDULE_JOBS.every((job) => !taskAbsent(job));
    }, { timeoutMs: 60_000, label: "row 83 schedule.verify and five tasks" }); }
    catch (error) {
      error.acceptanceStatus = /Task Scheduler absence query/iu.test(error?.message ?? "")
        ? "harness_error" : "assertion_failed";
      throw error;
    }
    await verifyScheduleIpc(page, SCHEDULE_PROJECT);
    await systemReadback(page, profile);
  };
  return {
    async baselineUi({ page, profile, noteIpc }) {
      if (!SCHEDULE_JOBS.every((job) => taskAbsent(job))) {
        throw new Error("Hosted runner already has a synthetic task-83 name");
      }
      noteIpc({ operation: "settings.set", itemId: 83, fields: ["projects_root", "close_to_tray"] });
      await page.evaluate((root) => window.siteindex.settings.set({ projects_root: root, close_to_tray: false }),
        profile.layout.projectRoot);
      await createWorkspace(page, profile, SCHEDULE_PROJECT, "https://task83.example.test");
      created = true;
      siteFile = path.join(profile.layout.projectRoot, SCHEDULE_PROJECT, "_site-index", "site.json");
      await navigate(page, `#/p/${SCHEDULE_PROJECT}/runs`, "定时计划");
      noteIpc({ operation: "schedule.save", itemId: 83 });
      try { await editScheduleItem(page, SCHEDULE_PROJECT); }
      catch (error) {
        if (/daily schedule UI save/iu.test(error?.message ?? "")) error.acceptanceStatus = "assertion_failed";
        throw error;
      }
    },
    async verifyBaselineIpc({ page, profile, noteIpc }) {
      noteIpc({ operation: "schedule.get/verify/listSystemTasks", itemId: 83 });
      await verifyIpc(page, profile);
    },
    async verifyBaselineFile() {
      await verifyScheduleFile(siteFile);
      baselineBytes = await readFile(siteFile);
    },
    async candidateUi({ page }) {
      if (!baselineBytes || !(await readFile(siteFile)).equals(baselineBytes)) {
        throw failed("Row 83 candidate overwrite changed schedule config bytes");
      }
      await navigate(page, `#/p/${SCHEDULE_PROJECT}/runs`, "定时计划");
      await page.getByText("每周二、四 · 17:44", { exact: true }).waitFor();
      await page.getByText("已注册到任务计划程序").waitFor();
    },
    async verifyCandidateIpc({ page, profile, noteIpc }) {
      noteIpc({ operation: "schedule.get/verify/listSystemTasks", itemId: 83 });
      await verifyIpc(page, profile);
    },
    async verifyCandidateFile() {
      await verifyScheduleFile(siteFile);
      if (!(await readFile(siteFile)).equals(baselineBytes)) {
        throw failed("Row 83 candidate startup rewrote schedule config bytes");
      }
    },
    async cleanupSystem({ page, noteIpc }) {
      if (!created) return;
      let saveError;
      try {
        noteIpc({ operation: "schedule.save", itemId: 83, mode: "disable" });
        await page.evaluate(async (id) => {
          const state = await window.siteindex.schedule.get(id);
          const config = structuredClone(state.config);
          for (const job of ["daily", "validate", "weekly", "readme", "monthly"]) config[job].enabled = false;
          return window.siteindex.schedule.save(id, config);
        }, SCHEDULE_PROJECT);
        await waitForObserved(() => SCHEDULE_JOBS.every((job) => taskAbsent(job)),
          { label: "five synthetic system tasks removed by packaged API" });
      } catch (error) { saveError = error; }
      for (const job of SCHEDULE_JOBS) removeOwnedTask(job);
      if (saveError) throw failed("Row 83 packaged task disable did not clean all five system tasks");
    },
  };
}

export function sensitiveSystemHandlers(ids, credentials) {
  return Object.fromEntries(ids.map((id) => {
    if (id === 82) return [id, credentialAdapter(credentials)];
    if (id === 83) return [id, scheduleAdapter()];
    throw new Error(`Unsupported sensitive/system row ${id}`);
  }));
}
