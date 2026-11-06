import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { pathsFor } from "@siteindex/shared";
import { afterEach, describe, expect, it } from "vitest";
import { validateProjectFiles, repairProjectFile } from "../src/validate";
import { resolveProjectLayout } from "../src/io/project-layout";
import { readJsonl } from "../src/io/jsonl";

const fixture = path.resolve(process.cwd(), "fixtures/expected/project");
const fixtureInput = path.resolve(process.cwd(), "fixtures/inputs/site.json");
const legacyPaths = pathsFor("legacy");
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function projectCopy(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-validate-"));
  roots.push(root);
  const project = path.join(root, "project");
  await cp(fixture, project, { recursive: true });
  return project;
}
async function workspaceProjectCopy(): Promise<string> {
  const project = await projectCopy();
  const legacy = pathsFor("legacy");
  const workspace = pathsFor("workspace");
  await rename(path.join(project, legacy.index), path.join(project, workspace.index));
  await writeFile(path.join(project, ".gitignore"), ".env\n_tmp/\n", "utf8");
  await writeFile(path.join(project, ".env"), "", "utf8");
  return project;
}
async function minimalProject(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-validate-minimal-"));
  roots.push(root);
  const project = path.join(root, "project");
  await mkdir(path.dirname(path.join(project, legacyPaths.site)), { recursive: true });
  await mkdir(path.dirname(path.join(project, legacyPaths.skus)), { recursive: true });
  await writeFile(path.join(project, legacyPaths.site), await readFile(fixtureInput));
  await writeFile(path.join(project, legacyPaths.skus), await readFile(path.join(fixture, legacyPaths.skus)));
  return project;
}

function validationGolden(report: Awaited<ReturnType<typeof validateProjectFiles>>) {
  return {
    checked_at: report.checked_at,
    trigger: report.trigger,
    summary: report.summary,
    files: report.files.map(({ path: filePath, kind, status, rule, repair, records, message }) =>
      [filePath, kind, status, rule ?? "", repair ?? "", records === undefined ? "" : String(records), message ?? ""].join(" | ")),
  };
}

describe("project validation and repair", () => {
  it("prefers workspace config when both layout config files exist", async () => {
    const project = await projectCopy();
    const workspaceConfig = path.join(project, pathsFor("workspace").site);
    await mkdir(path.dirname(workspaceConfig), { recursive: true });
    await cp(path.join(project, pathsFor("legacy").site), workspaceConfig);

    expect(await resolveProjectLayout(project)).toBe("workspace");
  });

  it("returns a structured project-not-found error when neither config exists", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-layout-missing-"));
    roots.push(root);

    await expect(resolveProjectLayout(root)).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
  });

  it("matches the legacy layout validation golden", async () => {
    const project = await projectCopy();
    expect(await resolveProjectLayout(project)).toBe("legacy");
    const report = await validateProjectFiles(project, { trigger: "manual", now: new Date("2026-10-22T12:00:00Z") });

    expect(validationGolden(report)).toMatchSnapshot("legacy layout");
    expect(await readFile(path.join(project, pathsFor("legacy").validation), "utf8")).toBe(JSON.stringify(report, null, 2) + "\n");
  }, 20_000);

  it("matches the workspace layout validation golden and writes under _site-index", async () => {
    const project = await workspaceProjectCopy();
    expect(await resolveProjectLayout(project)).toBe("workspace");
    const report = await validateProjectFiles(project, { trigger: "manual", now: new Date("2026-10-22T12:00:00Z") });

    expect(validationGolden(report)).toMatchSnapshot("workspace layout");
    expect(await readFile(path.join(project, pathsFor("workspace").validation), "utf8")).toBe(JSON.stringify(report, null, 2) + "\n");
    expect(report.files.some((check) => check.path.startsWith(legacyPaths.index + "/"))).toBe(false);
    expect(report.files.some((check) => check.path.startsWith(pathsFor("workspace").index + "/"))).toBe(true);
  }, 20_000);

  it("requires workspace .gitignore to exclude .env and accepts glob/negation ordering", async () => {
    const project = await workspaceProjectCopy();
    const gitignore = path.join(project, ".gitignore");
    const valid = await validateProjectFiles(project, { now: new Date("2026-10-22T12:00:00Z") });
    expect(valid.files.find((check) => check.path === ".gitignore")).toMatchObject({ status: "ok" });

    await writeFile(gitignore, "*.env\n!/.env\n", "utf8");
    const invalid = await validateProjectFiles(project, { now: new Date("2026-10-22T12:00:00Z") });
    expect(invalid.files.find((check) => check.path === ".gitignore")).toMatchObject({ status: "error", rule: "schema" });

    await writeFile(gitignore, "*.env\n", "utf8");
    const globbed = await validateProjectFiles(project, { now: new Date("2026-10-22T12:00:00Z") });
    expect(globbed.files.find((check) => check.path === ".gitignore")).toMatchObject({ status: "ok" });
  }, 20_000);

  it("does not inspect or reject files in the workspace EDM skill-owned whitelist", async () => {
    const project = await workspaceProjectCopy();
    const edmOwnedFile = path.join(project, pathsFor("workspace").index, "edm", "skill-owned.md");
    await mkdir(path.dirname(edmOwnedFile), { recursive: true });
    await writeFile(edmOwnedFile, "skill-owned fictional content\n", "utf8");

    const report = await validateProjectFiles(project, { now: new Date("2026-10-22T12:00:00Z") });
    expect(report.files.some((check) => check.path.startsWith(pathsFor("workspace").index + "/edm/"))).toBe(false);
    expect(report.files.some((check) => check.path === ".gitignore" && check.status === "error")).toBe(false);
  }, 20_000);

  it("applies autofix, archive restore, and conflict quarantine inside workspace paths", async () => {
    const project = await workspaceProjectCopy();
    const paths = pathsFor("workspace");
    const productsFile = path.join(project, paths.productsView);
    const original = await readJsonl(productsFile);
    await writeFile(productsFile, [original[1]!, original[0]!, original[0]!].map((row) => JSON.stringify(row)).join("\n") + "\n");
    await repairProjectFile(project, paths.productsView, "autofix", { runJob: async () => ({ status: "ok", summary: "ok" }) });
    const sorted = await readJsonl(productsFile);
    expect(sorted).toHaveLength(2);
    expect(sorted.map((row) => row.handle)).toEqual([...sorted.map((row) => row.handle)].sort());

    const relative = paths.keywords;
    const contents = "{\"keyword\":\"restored\"}\n";
    const archive = path.join(project, paths.archiveDir, "2026-10", relative + ".gz");
    await mkdir(path.dirname(archive), { recursive: true });
    await writeFile(archive, gzipSync(contents));
    await repairProjectFile(project, relative, "restore_archive", { runJob: async () => ({ status: "ok", summary: "ok" }) });
    expect(await readFile(path.join(project, relative), "utf8")).toBe(contents);

    const copyRelative = path.posix.join(path.posix.dirname(paths.seoPages), "pages (1).jsonl");
    const copy = path.join(project, copyRelative);
    await mkdir(path.dirname(copy), { recursive: true });
    await writeFile(copy, "conflict copy\n");
    await repairProjectFile(project, copyRelative, "delete_copy", { runJob: async () => ({ status: "ok", summary: "ok" }) });
    await expect(readFile(copy, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const quarantine = path.join(project, paths.archiveDir, "quarantine", new Date().toISOString().slice(0, 10));
    expect(await readdir(quarantine)).toEqual(expect.arrayContaining([expect.stringContaining("pages (1).jsonl")]));
  }, 20_000);

  it("reports schema errors for malformed SEO rows and writes a report", async () => {
    const project = await projectCopy();
    const file = path.join(project, legacyPaths.seoPages);
    const rows = await readJsonl(file);
    if (!rows.length) rows.push({ url: "https://example.com/", page_type: "home", status_code: 200, title: "Home", title_length: 4,
      meta_description: "Description", description_length: 11, h1: "Home", h1_count: 1, canonical: "https://example.com/",
      canonical_status: "self", robots_meta: null, x_robots_tag: null, indexable: true, in_sitemap: true, schema_types: [], word_count: 1, last_crawled: "2026-10-22" });
    rows[0]!.page_type = "invalid_page";
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    const report = await validateProjectFiles(project, { trigger: "manual", now: new Date("2026-10-22T12:00:00Z") });
    expect(report.summary.error).toBeGreaterThan(0);
    expect(report.files.find((item) => item.path === legacyPaths.seoPages)).toMatchObject({ status: "error", rule: "schema" });
    expect(JSON.parse(await readFile(path.join(project, legacyPaths.validation), "utf8"))).toEqual(report);
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
    const file = path.join(project, legacyPaths.productsView);
    const original = await readJsonl(file);
    await writeFile(file, [original[1]!, original[0]!, original[0]!].map((row) => JSON.stringify(row)).join("\n") + "\n");
    await repairProjectFile(project, legacyPaths.productsView, "autofix", { runJob: async () => ({ status: "ok", summary: "ok" }) });
    const sorted = await readJsonl(file);
    expect(sorted).toHaveLength(2);
    expect(sorted.map((row) => row.handle)).toEqual([...sorted.map((row) => row.handle)].sort());
    await expect(validateProjectFiles(project, { selectedPath: "..\\outside" })).rejects.toThrow("路径必须位于项目目录内");
    await expect(repairProjectFile(project, "..\\outside", "delete_copy", { runJob: async () => ({ status: "ok", summary: "ok" }) }))
      .rejects.toThrow("路径必须位于项目目录内");
  }, 20_000);

  it("restores the newest compressed archive and moves conflict copies to quarantine", async () => {
    const project = await projectCopy();
    const relative = legacyPaths.keywords;
    const contents = "{\"keyword\":\"restored\"}\n";
    const archive = path.join(project, legacyPaths.archiveDir, "2026-10", relative + ".gz");
    await mkdir(path.dirname(archive), { recursive: true });
    await writeFile(archive, gzipSync(contents));
    await repairProjectFile(project, relative, "restore_archive", { runJob: async () => ({ status: "ok", summary: "ok" }) });
    expect(await readFile(path.join(project, relative), "utf8")).toBe(contents);

    const copyRelative = path.posix.join(path.posix.dirname(legacyPaths.seoPages), "pages (1).jsonl");
    const copy = path.join(project, copyRelative);
    await mkdir(path.dirname(copy), { recursive: true });
    await writeFile(copy, "conflict copy\n");
    await repairProjectFile(project, copyRelative, "delete_copy", { runJob: async () => ({ status: "ok", summary: "ok" }) });
    await expect(readFile(copy, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const quarantine = path.join(project, legacyPaths.archiveDir, "quarantine", new Date().toISOString().slice(0, 10));
    expect(await readdir(quarantine)).toEqual(expect.arrayContaining([expect.stringContaining("pages (1).jsonl")]));
  }, 20_000);
});
