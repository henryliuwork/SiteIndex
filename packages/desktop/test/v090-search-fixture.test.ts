import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";
import { createCategoryScheduleFixture } from "../scripts/acceptance/category-schedule-fixture.mjs";

describe("v0.9.0 packaged search fixture", () => {
  it("reuses synthetic product, SEO and content rows for matrix 85 only", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-v090-search-"));
    try {
      const profile = { layout: { projectRoot: root } };
      const fixture = await createCategoryScheduleFixture(profile, 85, "synthetic-device");
      assert.equal(fixture.projectId, "matrix-85");
      for (const file of ["views/products.jsonl", "seo/pages.jsonl", "content/blog_index.jsonl"]) {
        const rows = (await readFile(path.join(fixture.projectDir, "index", file), "utf8"))
          .trim().split("\n").map((line) => JSON.parse(line));
        assert.ok(rows.length > 0, `${file} has synthetic search rows`);
      }
      assert.match(await readFile(fixture.siteFile, "utf8"), /fixture\.example\.test/u);
      await assert.rejects(() => createCategoryScheduleFixture(profile, 84, "synthetic-device"), /Invalid synthetic/u);
      await assert.rejects(() => createCategoryScheduleFixture(profile, 86, "synthetic-device"), /Invalid synthetic/u);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
