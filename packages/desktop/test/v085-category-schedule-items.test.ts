import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, vi } from "vitest";
import {
  CATEGORY_SCHEDULE_ITEMS, categoryScheduleItem, editCategoryScheduleItem,
  verifyCategoryScheduleFile, verifyCategoryScheduleIpc,
} from "../scripts/acceptance/category-schedule-items.mjs";

function configFor(item) {
  if (item.id === 46) return { categories: { mode: item.expected } };
  if (item.id === 47) return { categories: { url_pattern: item.expected } };
  if (item.id >= 48 && item.id <= 50) return { categories: { manual: [{ [item.field]: item.expected }] } };
  if (item.id === 51) return { categories: { manual: [{ match: [item.expected] }] } };
  if (item.kind === "job") return { schedule: { [item.job]: item.expected } };
  return { schedule: { options: { [item.option]: item.expected } } };
}

function fakePage(item, { focusSummary = true, config = configFor(item) } = {}) {
  const calls = [];
  const control = {
    click: vi.fn(async () => { calls.push("click"); }),
    check: vi.fn(async () => { calls.push("check"); }),
    fill: vi.fn(async (value) => { calls.push(["fill", value]); }),
    focus: vi.fn(async () => { calls.push("focus"); }),
    waitFor: vi.fn(async () => { calls.push("hidden"); }),
    first: vi.fn(() => control), last: vi.fn(() => control), nth: vi.fn(() => control),
    getByRole: vi.fn(() => control),
  };
  let evaluatedFocus = false;
  const page = {
    getByRole: vi.fn(() => control),
    keyboard: { press: vi.fn(async (key) => { calls.push(key); }) },
    evaluate: vi.fn(async () => {
      if (item.kind === "option" && !evaluatedFocus) { evaluatedFocus = true; return focusSummary; }
      return { config };
    }),
  };
  return { page, control, calls };
}

describe("v0.8.5 category/schedule matrix rows 46–60", () => {
  it("preserves all legacy IDs and expected config semantics", () => {
    assert.deepEqual(CATEGORY_SCHEDULE_ITEMS.map((item) => item.id),
      Array.from({ length: 15 }, (_, index) => index + 46));
    assert.equal(categoryScheduleItem(46).expected, "url_rule");
    assert.equal(categoryScheduleItem(47).expected, "/shop/{slug}, /gear/{slug}");
    assert.deepEqual(categoryScheduleItem(51).expected, { type: "url_contains", value: "renamed-category" });
    assert.equal(categoryScheduleItem(52).job, "daily");
    assert.deepEqual(categoryScheduleItem(56).expected,
      { enabled: true, days: [], time: "03:56", day_of_month: 12 });
    assert.equal(categoryScheduleItem(60).option, "validate_after_sync");
  });

  it("uses role actions for category, job and keyboard-disclosed options", async () => {
    for (const id of [46, 47, 48, 51, 52, 56, 57]) {
      const item = categoryScheduleItem(id);
      const { page, control, calls } = fakePage(item);
      await editCategoryScheduleItem(page, item, "synthetic-project");
      if (id <= 51) assert(page.getByRole.mock.calls.some(([role, options]) =>
        role === "button" && options?.name === "保存并重新归类"));
      if (id === 52 || id === 56) {
        assert(control.waitFor.mock.calls.some(([options]) => options.state === "hidden"));
        assert(control.fill.mock.calls.some(([value]) => value === item.expected.time));
      }
      if (id === 57) assert.deepEqual(calls.slice(0, 4), ["focus", "Tab", "Enter", "check"]);
    }
  });

  it("labels a broken summary focus order as harness_error", async () => {
    const item = categoryScheduleItem(58);
    await assert.rejects(() => editCategoryScheduleItem(fakePage(item, { focusSummary: false }).page,
      item, "synthetic-project"), (error) => error.acceptanceStatus === "harness_error");
  });

  it("reads file and IPC independently and rejects an unsaved value", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "siteindex-category-schedule-item-"));
    const siteFile = path.join(directory, "site.json");
    const item = categoryScheduleItem(52);
    try {
      await writeFile(siteFile, JSON.stringify(configFor(item)));
      assert.deepEqual(await verifyCategoryScheduleFile(item, siteFile),
        { id: 52, phase: "file-readback", status: "passed" });
      assert.deepEqual(await verifyCategoryScheduleIpc(item, fakePage(item).page, "synthetic-project"),
        { id: 52, phase: "ipc-readback", status: "passed" });
      const stale = { schedule: { daily: { enabled: false } } };
      await writeFile(siteFile, JSON.stringify(stale));
      await assert.rejects(() => verifyCategoryScheduleFile(item, siteFile), /not persisted/u);
      await assert.rejects(() => verifyCategoryScheduleIpc(item, fakePage(item, { config: stale }).page,
        "synthetic-project"), /not persisted/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
