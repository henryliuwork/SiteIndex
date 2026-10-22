import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { PATHS } from "@siteindex/shared";
import { afterEach, describe, expect, it } from "vitest";
import { validateProjectFiles, repairProjectFile } from "../src/validate";
import { readJsonl } from "../src/io/jsonl";

const fixture = path.resolve(process.cwd(), "fixtures/expected/project");
const fixtureInput = path.resolve(process.cwd(), "fixtures/inputs/site.json");
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function projectCopy(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-validate-"));
  roots.push(root);
  const project = path.join(root, "project");
  await cp(fixture, project, { recursive: true });
  return project;
}
async function minimalProject(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-validate-minimal-"));
  roots.push(root);
  const project = path.join(root, "project");
  await mkdir(path.dirname(path.join(project, PATHS.site)), { recursive: true });
  await mkdir(path.dirname(path.join(project, PATHS.skus)), { recursive: true });
  await writeFile(path.join(project, PATHS.site), await readFile(fixtureInput));
  await writeFile(path.join(project, PATHS.skus), await readFile(path.join(fixture, PATHS.skus)));
  return project;
}

describe("project validation and repair", () => {
  it("reports schema errors for malformed SEO rows and writes a report", async () => {
    const project = await projectCopy();
    const file = path.join(project, PATHS.seoPages);
    const rows = await readJsonl(file);
    if (!rows.length) rows.push({ url: "https://example.com/", page_type: "home", status_code: 200, title: "Home", title_length: 4,
      meta_description: "Description", description_length: 11, h1: "Home", h1_count: 1, canonical: "https://example.com/",
      canonical_status: "self", robots_meta: null, x_robots_tag: null, indexable: true, in_sitemap: true, schema_types: [], word_count: 1, last_crawled: "2026-10-22" });
    rows[0]!.page_type = "invalid_page";
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    const report = await validateProjectFiles(project, { trigger: "manual", now: new Date("2026-10-22T12:00:00Z") });
    expect(report.summary.error).toBeGreaterThan(0);
    expect(report.files.find((item) => item.path === PATHS.seoPages)).toMatchObject({ status: "error", rule: "schema" });
    expect(JSON.parse(await readFile(path.join(project, PATHS.validation), "utf8"))).toEqual(report);
  }, 20_000);

  it("covers the expected rule types in every invalid fixture", async () => {
    const invalidDir = path.resolve(process.cwd(), "fixtures/invalid");
    const cases = [
      ["bad_outreach_domain.json", ["schema", "sort"]],
      ["bad_stock_status.json", ["schema"]],
      ["bad_url_in_media.json", ["schema"]],
      ["duplicate_keyword.json", ["pk_duplicate", "sort"]],
      ["orphan_latest_sku.json", ["ref"]],
      ["unsorted_skus.json", ["sort"]],
    ] as const;
    for (const [name, expectedRules] of cases) {
      const project = await minimalProject();
      const invalid = JSON.parse(await readFile(path.join(invalidDir, name), "utf8")) as { file: string; content: string };
      const target = path.join(project, invalid.file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, invalid.content);
      const report = await validateProjectFiles(project, { now: new Date("2026-10-22T12:00:00Z") });
      const actual = report.files.filter((check) => check.path === invalid.file).map((check) => check.rule);
      for (const rule of expectedRules) expect(actual).toContain(rule);
    }
  }, 30_000);

  it("autofix sorts and deduplicates rows while keeping paths inside the project", async () => {
    const project = await projectCopy();
    const file = path.join(project, PATHS.productsView);
    const original = await readJsonl(file);
    await writeFile(file, [original[1]!, original[0]!, original[0]!].map((row) => JSON.stringify(row)).join("\n") + "\n");
    await repairProjectFile(project, PATHS.productsView, "autofix", { runJob: async () => ({ status: "ok", summary: "ok" }) });
    const sorted = await readJsonl(file);
    expect(sorted).toHaveLength(2);
    expect(sorted.map((row) => row.handle)).toEqual([...sorted.map((row) => row.handle)].sort());
    await expect(validateProjectFiles(project, { selectedPath: "..\\outside" })).rejects.toThrow("路径必须位于项目目录内");
    await expect(repairProjectFile(project, "..\\outside", "delete_copy", { runJob: async () => ({ status: "ok", summary: "ok" }) }))
      .rejects.toThrow("路径必须位于项目目录内");
  }, 20_000);

  it("restores the newest compressed archive and moves conflict copies to quarantine", async () => {
    const project = await projectCopy();
    const relative = PATHS.keywords;
    const contents = "{\"keyword\":\"restored\"}\n";
    const archive = path.join(project, PATHS.archiveDir, "2026-10", relative + ".gz");
    await mkdir(path.dirname(archive), { recursive: true });
    await writeFile(archive, gzipSync(contents));
    await repairProjectFile(project, relative, "restore_archive", { runJob: async () => ({ status: "ok", summary: "ok" }) });
    expect(await readFile(path.join(project, relative), "utf8")).toBe(contents);

    const copy = path.join(project, "index/seo/pages (1).jsonl");
    await mkdir(path.dirname(copy), { recursive: true });
    await writeFile(copy, "conflict copy\n");
    await repairProjectFile(project, "index/seo/pages (1).jsonl", "delete_copy", { runJob: async () => ({ status: "ok", summary: "ok" }) });
    await expect(readFile(copy, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const quarantine = path.join(project, PATHS.archiveDir, "quarantine", new Date().toISOString().slice(0, 10));
    expect(await readdir(quarantine)).toEqual(expect.arrayContaining([expect.stringContaining("pages (1).jsonl")]));
  }, 20_000);
});
