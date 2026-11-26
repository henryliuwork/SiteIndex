import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";
import { categoryScheduleAdapter, categoryScheduleHandlers,
  scheduleVerificationEvidence, scheduleVerifyAccepted } from "../scripts/acceptance/category-schedule-adapters.mjs";
import { createCategoryScheduleFixture } from "../scripts/acceptance/category-schedule-fixture.mjs";

describe("v0.8.5 category and schedule adapters 46–60", () => {
  it("maps the frozen matrix and limits D18/D19 to rows 52–56", () => {
    assert.deepEqual(Object.keys(categoryScheduleHandlers([46, 52, 56, 60])), ["46", "52", "56", "60"]);
    assert.throws(() => categoryScheduleAdapter(61), /Unknown category/u);
    const oldError = { state: "error", message: "读取计划任务失败：schtasks.exe 执行失败。" };
    for (const id of [52, 53, 54, 55, 56]) assert.equal(scheduleVerifyAccepted(id, oldError), true);
    for (const id of [52, 53, 54, 55, 56]) assert.deepEqual(scheduleVerificationEvidence(id, oldError), oldError);
    for (const id of [51, 57, 60]) assert.equal(scheduleVerifyAccepted(id, oldError), false);
    for (const id of [51, 57, 60]) assert.equal(scheduleVerificationEvidence(id, oldError), null);
    assert.equal(scheduleVerifyAccepted(52, { state: "error", message: "Other error" }), false);
    assert.equal(scheduleVerificationEvidence(52, { state: "error", message: "Other error" }), null);
    assert.deepEqual(scheduleVerificationEvidence(52, { state: "ok", message: "Should not copy arbitrary text" }), { state: "ok" });
  });

  it("creates only synthetic legacy fixture files and disabled schedules", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-category-fixture-"));
    try {
      const profile = { layout: { projectRoot: root } };
      const category = await createCategoryScheduleFixture(profile, 48, "synthetic-device");
      const config = JSON.parse(await readFile(category.siteFile, "utf8"));
      assert.equal(config.categories.mode, "manual");
      assert.equal(config.categories.manual[0].slug, "base-category");
      assert(config.categories.manual[0].url.endsWith("fixture.example.test/collections/base-category"));
      assert.equal(config.schedule.daily.enabled, false);
      const runner = JSON.parse(await readFile(path.join(category.projectDir, "index", ".runner.json"), "utf8"));
      assert.equal(runner.device_id, "synthetic-device");
      const schedule = await createCategoryScheduleFixture(profile, 52, "synthetic-device");
      const scheduleConfig = JSON.parse(await readFile(schedule.siteFile, "utf8"));
      assert.equal(scheduleConfig.schedule.options.wake_to_run, false);
      assert.equal(scheduleConfig.base_url, "https://fixture.example.test");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
