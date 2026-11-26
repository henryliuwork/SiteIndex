import { readFile } from "node:fs/promises";
import { assertPersisted } from "./report.mjs";
import { waitForObserved } from "./session.mjs";

const TODO_RULE = "seo.issue.title_missing";
const README_TITLES = { overview: "项目概况", focus: "当前重点", rules: "工作规则与偏好" };

// v0.8.2 setting matrix rows 61–66. The shared driver owns fresh sessions and upgrade/cleanup.
export const INDEPENDENT_ITEMS = [
  { id: 61, kind: "runner", expected: "local" },
  { id: 62, kind: "readme", block: "overview", expected: "Synthetic project overview." },
  { id: 63, kind: "readme", block: "focus", expected: "Review synthetic products this week." },
  { id: 64, kind: "readme", block: "rules", expected: "Use only example.test synthetic data.", missingTitleCase: true },
  { id: 65, kind: "todo", field: "status", expected: "in_progress" },
  { id: 66, kind: "todo", field: "note", expected: "Synthetic review note." },
];

export function independentItem(id) {
  const item = INDEPENDENT_ITEMS.find((entry) => entry.id === id);
  if (!item) throw new Error(`Unknown independent matrix row ${id}`);
  return item;
}

function todoFinding(items) {
  const item = items.find((entry) => entry.finding.rule_id === TODO_RULE);
  if (!item) throw new Error("Synthetic SEO finding is missing from the isolated fixture");
  return item;
}

/** Edits one item through the installed UI; caller supplies the correct project route and profile. */
export async function editIndependentItem(page, item, projectId) {
  if (item.kind === "runner") {
    await page.getByRole("button", { name: "改为本机" }).click();
    await waitForObserved(async () => (await page.evaluate((id) => window.siteindex.runner.get(id), projectId))
      .is_this_device, { label: `independent row ${item.id} runner claim` });
    return {};
  }
  if (item.kind === "readme") {
    if (item.block === "rules") await page.getByRole("button", { name: "编辑", exact: true }).click();
    await page.getByRole("textbox", { name: README_TITLES[item.block], exact: true }).fill(item.expected);
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await waitForObserved(async () => (await page.evaluate((id) => window.siteindex.readme.get(id), projectId))
      .user_blocks[item.block] === item.expected, { label: `independent row ${item.id} README save` });
    return {};
  }
  const listed = await page.evaluate((id) => window.siteindex.todos.list(id), projectId);
  const finding = todoFinding(listed.items);
  const escapedTitle = finding.finding.title.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  await page.getByRole("row", { name: new RegExp(escapedTitle, "u") }).click();
  if (item.field === "status") {
    await page.getByRole("combobox", { name: "更新待办状态" }).click();
    await page.getByRole("option", { name: "进行中" }).click();
    await page.getByRole("button", { name: "保存状态" }).click();
  } else {
    await page.getByRole("textbox", { name: "编辑待办备注" }).fill(item.expected);
    await page.getByRole("button", { name: "保存备注" }).click();
  }
  await waitForObserved(async () => {
    const rows = await page.evaluate((id) => window.siteindex.todos.list(id), projectId);
    return rows.items.find((entry) => entry.finding.dedupe_key === finding.finding.dedupe_key)
      ?.state[item.field] === item.expected;
  }, { label: `independent row ${item.id} todo save` });
  return { todoKey: finding.finding.dedupe_key };
}

export function readReadmeSection(markdown, title) {
  const match = markdown.match(new RegExp(`(?:^|\\n)## ${title}\\r?\\n([\\s\\S]*?)(?=\\r?\\n(?:## |<!-- siteindex:auto:start\\b)|$)`, "u"));
  return match?.[1].trim();
}

/** Read after normal exit, then again after candidate overwrite; no in-memory draft is trusted. */
export async function verifyIndependentFile(item, targetFile, todoKey) {
  const text = await readFile(targetFile, "utf8");
  let value;
  if (item.kind === "runner") value = JSON.parse(text).device_id;
  else if (item.kind === "readme") value = readReadmeSection(text, README_TITLES[item.block]);
  else {
    const rows = text.trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
    value = rows.find((row) => row.dedupe_key === todoKey)?.[item.field];
  }
  if (item.kind === "runner") {
    if (typeof value !== "string" || !value) throw new Error("Runner claim was not persisted");
  } else assertPersisted(value, item.expected);
  return { id: item.id, phase: "file-readback", status: "passed", runnerDeviceId: item.kind === "runner" ? value : undefined };
}

export async function verifyIndependentIpc(item, page, projectId, todoKey, runnerDeviceId) {
  let value;
  if (item.kind === "runner") {
    const state = await page.evaluate((id) => window.siteindex.runner.get(id), projectId);
    value = state.is_this_device && state.runner?.device_id === state.this_device.device_id
      ? state.runner.device_id : null;
    assertPersisted(value, runnerDeviceId);
  } else if (item.kind === "readme") {
    value = (await page.evaluate((id) => window.siteindex.readme.get(id), projectId)).user_blocks[item.block];
    assertPersisted(value, item.expected);
  } else {
    const rows = await page.evaluate((id) => window.siteindex.todos.list(id), projectId);
    value = rows.items.find((entry) => entry.finding.dedupe_key === todoKey)?.state[item.field];
    assertPersisted(value, item.expected);
  }
  return { id: item.id, phase: "ipc-readback", status: "passed" };
}
