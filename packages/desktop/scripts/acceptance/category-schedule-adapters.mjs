import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { assertPersisted } from "./report.mjs";
import { waitForObserved } from "./session.mjs";
import { createCategoryScheduleFixture } from "./category-schedule-fixture.mjs";
import { categoryScheduleItem, categoryScheduleValue, editCategoryScheduleItem,
  verifyCategoryScheduleFile, verifyCategoryScheduleIpc } from "./category-schedule-items.mjs";

const JOBS = ["daily", "validate", "weekly", "readme", "monthly"];
const KNOWN_VERIFY_ERROR = "读取计划任务失败：schtasks.exe 执行失败。";
const disabledJob = () => ({ enabled: false, days: [], time: "00:00" });
const disabledSchedule = () => ({ daily: disabledJob(), validate: disabledJob(), weekly: disabledJob(),
  readme: disabledJob(), monthly: { ...disabledJob(), day_of_month: 1 },
  options: { wake_to_run: false, run_if_missed: false, notify_on_failure: false, validate_after_sync: false } });

function failure(message) {
  const error = new Error(message);
  error.acceptanceStatus = "assertion_failed";
  return error;
}

function taskName(projectId, job) { return `\\SiteIndex\\${projectId}-${job}`; }

function harness(message) {
  const error = new Error(message);
  error.acceptanceStatus = "harness_error";
  return error;
}

export function scheduleVerifyAccepted(id, verification) {
  return verification?.state === "ok" || (id >= 52 && id <= 56
    && verification?.state === "error" && verification?.message === KNOWN_VERIFY_ERROR);
}

export function scheduleVerificationEvidence(id, verification) {
  if (id < 52 || id > 56 || !scheduleVerifyAccepted(id, verification)) return null;
  return { state: verification.state,
    ...(verification.state === "error" ? { message: verification.message } : {}) };
}

function nativeTask(name, run = spawnSync) {
  const result = run("schtasks.exe", ["/Query", "/TN", name, "/XML"],
    { encoding: "utf8", windowsHide: true, timeout: 20_000 });
  if (result.error) throw harness("schtasks query could not start");
  if (result.status === 1 && /cannot find|does not exist|not found|找不到|不存在/iu
    .test(`${result.stdout}\n${result.stderr}`)) return null;
  if (result.status !== 0) throw harness(`schtasks query exited ${result.status ?? "unknown"}`);
  if (!/<Task(?:\s|>)/u.test(result.stdout)) throw failure("Registered system task XML is unreadable");
  return result.stdout;
}

function removeOwnedTask(name, run = spawnSync) {
  if (!nativeTask(name, run)) return;
  const result = run("schtasks.exe", ["/Delete", "/TN", name, "/F"],
    { encoding: "utf8", windowsHide: true, timeout: 20_000 });
  if (result.error || result.status !== 0 || nativeTask(name, run)) {
    throw new Error("Synthetic Windows task cleanup failed");
  }
}

async function systemState(page, projectId, item) {
  const state = await page.evaluate(async ({ project, verify }) => ({
    verification: verify ? await window.siteindex.schedule.verify(project) : null,
    tasks: (await window.siteindex.schedule.listSystemTasks()).filter((task) => task.projectId === project),
  }), { project: projectId, verify: item.id >= 52 && item.id <= 56 });
  if (item.id < 52 || item.id > 56) {
    if (state.tasks.length) throw failure(`Row ${item.id} unexpectedly registered a system task`);
    return { names: [], verification: null };
  }
  const expected = taskName(projectId, item.job);
  if (!scheduleVerifyAccepted(item.id, state.verification) || state.tasks.length !== 1
    || state.tasks[0].taskName.toLowerCase() !== expected.toLowerCase()
    || !nativeTask(expected)) throw failure(`Row ${item.id} system task or XML is missing`);
  return { names: [expected], verification: scheduleVerificationEvidence(item.id, state.verification) };
}

/** D18/D19's known schedule.verify error applies only to rows 52–56. */
export function categoryScheduleAdapter(id) {
  const item = categoryScheduleItem(id);
  const projectId = `matrix-${id}`;
  let fixture;
  let baselineBytes;
  let baselineTasks;
  let baselineVerification;
  let candidateVerification;
  const navigate = async (page) => {
    await page.evaluate(({ project, target }) => { window.location.hash = `#/p/${project}/${target}`; },
      { project: projectId, target: id <= 51 ? "settings/categories" : "runs" });
    if (id <= 51) await page.getByRole("button", { name: "保存并重新归类" }).waitFor();
    else await page.getByRole("heading", { name: "定时计划" }).waitFor();
  };
  const verifyIpc = async (page) => {
    await verifyCategoryScheduleIpc(item, page, projectId);
    const extra = await page.evaluate(async ({ project, category }) => category
      ? { categories: await window.siteindex.categories.get(project) }
      : { schedule: (await window.siteindex.schedule.get(project)).config },
    { project: projectId, category: id <= 51 });
    assertPersisted(categoryScheduleValue(extra, item), item.expected);
    if (id >= 52) {
      let consecutive = 0;
      try { return await waitForObserved(async () => {
        try {
          const names = await systemState(page, projectId, item);
          return ++consecutive >= 2 ? names : false;
        } catch (error) { consecutive = 0; throw error; }
      },
        { timeoutMs: 60_000, label: `row ${id} system task stability` }); }
      catch (error) {
        error.acceptanceStatus = /schtasks query (could not start|exited)/u.test(error.message)
          ? "harness_error" : "assertion_failed";
        throw error;
      }
    }
    return { names: [], verification: null };
  };
  return {
    ...(id >= 52 && id <= 56 ? { reportEvidence: () => ({
      baseline_schedule_verify: baselineVerification, candidate_schedule_verify: candidateVerification,
    }) } : {}),
    async baselineUi({ page, profile, noteIpc }) {
      noteIpc({ operation: "settings.set", itemId: id, fields: ["projects_root", "close_to_tray"] });
      const settings = await page.evaluate(async (root) => {
        await window.siteindex.settings.set({ projects_root: root, close_to_tray: false });
        return window.siteindex.settings.get();
      }, profile.layout.projectRoot);
      fixture = await createCategoryScheduleFixture(profile, id, settings.device_id);
      await navigate(page);
      noteIpc({ operation: id <= 51 ? "categories.save" : "schedule.save", itemId: id });
      try { await editCategoryScheduleItem(page, item, projectId); }
      catch (error) {
        if (/Timed out waiting for .* saved via IPC/iu.test(error?.message ?? "")) {
          error.acceptanceStatus = "assertion_failed";
        }
        throw error;
      }
    },
    async verifyBaselineIpc({ page, noteIpc }) {
      noteIpc({ operation: id <= 51 ? "categories.get" : "schedule.get", itemId: id });
      const observed = await verifyIpc(page);
      baselineTasks = observed.names;
      baselineVerification = observed.verification;
    },
    async verifyBaselineFile() {
      await verifyCategoryScheduleFile(item, fixture.siteFile);
      baselineBytes = await readFile(fixture.siteFile);
    },
    async candidateUi() {
      if (!baselineBytes || !(await readFile(fixture.siteFile)).equals(baselineBytes)) {
        throw failure(`Row ${id} config bytes changed during candidate overwrite`);
      }
    },
    async verifyCandidateIpc({ page, noteIpc }) {
      noteIpc({ operation: id <= 51 ? "categories.get" : "schedule.get", itemId: id });
      const observed = await verifyIpc(page);
      candidateVerification = observed.verification;
      if (!isDeepStrictEqual(observed.names.map((name) => name.toLowerCase()),
        baselineTasks.map((name) => name.toLowerCase()))) throw failure(`Row ${id} task identity changed`);
    },
    async verifyCandidateFile() {
      await verifyCategoryScheduleFile(item, fixture.siteFile);
      if (!(await readFile(fixture.siteFile)).equals(baselineBytes)) {
        throw failure(`Row ${id} candidate startup rewrote config bytes`);
      }
    },
    ...(id >= 52 ? { async cleanupSystem({ page, noteIpc }) {
      if (!fixture) return;
      let saveError;
      try {
        noteIpc({ operation: "schedule.save", itemId: id, mode: "disable" });
        await page.evaluate((project) => window.siteindex.schedule.save(project, disabledSchedule()), projectId);
        await waitForObserved(async () => (await page.evaluate(() => window.siteindex.schedule.listSystemTasks()))
          .every((task) => task.projectId !== projectId), { label: `row ${id} packaged task cleanup` });
      } catch (error) { saveError = error; }
      // Only the synthetic project's five known task names may be removed directly.
      for (const job of JOBS) removeOwnedTask(taskName(projectId, job));
      if (saveError) throw failure(`Row ${id} packaged task cleanup failed`);
    } } : {}),
  };
}

export function categoryScheduleHandlers(ids) {
  return Object.fromEntries(ids.map((id) => [id, categoryScheduleAdapter(id)]));
}
