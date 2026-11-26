import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { assertPersisted } from "./report.mjs";
import { waitForObserved } from "./session.mjs";

// v0.8.2 setting matrix rows 46–60. System task and XML checks belong to the shared upgrade driver.
export const CATEGORY_SCHEDULE_ITEMS = [
  { id: 46, kind: "mode", expected: "url_rule" },
  { id: 47, kind: "prefix", expected: "/shop/{slug}, /gear/{slug}" },
  { id: 48, kind: "category", field: "name", control: "分类名称", expected: "Synthetic renamed category" },
  { id: 49, kind: "category", field: "slug", control: "Slug", expected: "renamed-category" },
  { id: 50, kind: "category", field: "url", control: "分类页 URL", expected: "https://fixture.synthetic.invalid/collections/renamed-category" },
  { id: 51, kind: "category", field: "match", control: "匹配规则值 1", expected: { type: "url_contains", value: "renamed-category" } },
  { id: 52, kind: "job", job: "daily", title: "每日同步", expected: { enabled: true, days: [2], time: "03:52" } },
  { id: 53, kind: "job", job: "validate", title: "数据校验", expected: { enabled: true, days: [2], time: "03:53" } },
  { id: 54, kind: "job", job: "weekly", title: "每周同步（页面 / 博客 / SEO）", expected: { enabled: true, days: [2], time: "03:54" } },
  { id: 55, kind: "job", job: "readme", title: "刷新 README", expected: { enabled: true, days: [2], time: "03:55" } },
  { id: 56, kind: "job", job: "monthly", title: "每月同步（站点概况 / 设计规范）", expected: { enabled: true, days: [], time: "03:56", day_of_month: 12 } },
  { id: 57, kind: "option", option: "wake_to_run", control: "到点唤醒电脑执行", expected: true },
  { id: 58, kind: "option", option: "run_if_missed", control: "错过后开机尽快补跑", expected: true },
  { id: 59, kind: "option", option: "notify_on_failure", control: "失败时发送系统通知", expected: true },
  { id: 60, kind: "option", option: "validate_after_sync", control: "每次同步结束后自动校验写入的文件", expected: true },
];

export function categoryScheduleItem(id) {
  const item = CATEGORY_SCHEDULE_ITEMS.find((entry) => entry.id === id);
  if (!item) throw new Error(`Unknown category/schedule matrix row ${id}`);
  return item;
}

export function categoryScheduleValue(config, item) {
  if (item.id === 46) return config.categories.mode;
  if (item.id === 47) return config.categories.url_pattern;
  if (item.id >= 48 && item.id <= 50) return config.categories.manual?.[0]?.[item.field];
  if (item.id === 51) return config.categories.manual?.[0]?.match?.[0];
  if (item.kind === "job") return config.schedule[item.job];
  return config.schedule.options[item.option];
}

function optionsFocusError(id) {
  const error = new Error(`Matrix row ${id} options keyboard focus did not reach summary`);
  error.acceptanceStatus = "harness_error";
  return error;
}

/** UI actions only. Route, fresh profile, installation and cleanup belong to the shared driver. */
export async function editCategoryScheduleItem(page, item, projectId) {
  if (item.kind === "mode") {
    await page.getByRole("button", { name: "URL 规则", exact: true }).click();
  } else if (item.kind === "prefix") {
    await page.getByRole("button", { name: "+ 添加前缀" }).click();
    await page.getByRole("textbox", { name: "分类 URL 规则 2" }).fill("/gear/{slug}");
  } else if (item.kind === "category") {
    await page.getByRole("button", { name: "编辑", exact: true }).first().click();
    await page.getByRole("textbox", { name: item.control, exact: true })
      .fill(item.id === 51 ? item.expected.value : item.expected);
    await page.getByRole("button", { name: "完成编辑" }).click();
  } else if (item.kind === "job") {
    await page.getByRole("article").nth(item.id - 52).getByRole("button", { name: "编辑" }).click();
    const dialog = page.getByRole("dialog", { name: `编辑${item.title}计划` });
    await dialog.getByRole("checkbox", { name: "启用此任务" }).check();
    await dialog.getByRole("textbox", { name: "执行时间" }).fill(item.expected.time);
    if (item.job === "monthly") await dialog.getByRole("spinbutton", { name: "每月几号" }).fill("12");
    else await dialog.getByRole("group", { name: "执行星期" }).getByRole("button", { name: "二", exact: true }).click();
    await dialog.getByRole("button", { name: "保存计划" }).click();
    await dialog.waitFor({ state: "hidden", timeout: 30_000 });
  } else {
    await page.getByRole("button", { name: "编辑", exact: true }).last().focus();
    await page.keyboard.press("Tab");
    const focusedSummary = await page.evaluate(() => document.activeElement?.tagName === "SUMMARY"
      && document.activeElement.textContent?.trim() === "高级计划选项");
    if (!focusedSummary) throw optionsFocusError(item.id);
    await page.keyboard.press("Enter");
    await page.getByRole("checkbox", { name: item.control, exact: true }).check();
    await page.getByRole("button", { name: "保存计划", exact: true }).click();
  }
  if (item.id <= 51) await page.getByRole("button", { name: "保存并重新归类" }).click();
  await waitForObserved(async () => {
    const project = await page.evaluate((id) => window.siteindex.projects.get(id), projectId);
    return isDeepStrictEqual(categoryScheduleValue(project.config, item), item.expected);
  }, { timeoutMs: 30_000, label: `category/schedule row ${item.id} saved via IPC` });
}

export async function verifyCategoryScheduleFile(item, siteFile) {
  const config = JSON.parse(await readFile(siteFile, "utf8"));
  assertPersisted(categoryScheduleValue(config, item), item.expected);
  return { id: item.id, phase: "file-readback", status: "passed" };
}

export async function verifyCategoryScheduleIpc(item, page, projectId) {
  const project = await page.evaluate((id) => window.siteindex.projects.get(id), projectId);
  assertPersisted(categoryScheduleValue(project.config, item), item.expected);
  return { id: item.id, phase: "ipc-readback", status: "passed" };
}
