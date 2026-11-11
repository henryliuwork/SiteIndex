import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EDM_SKU_INDEX_PATHS, pathsFor, type ProjectLayout } from "@siteindex/shared";
import { afterEach, describe, expect, it } from "vitest";
import { createCoreService } from "../src/service";

const FIXTURE = path.resolve(process.cwd(), "fixtures/a-v041-edm-export");
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function projectFor(layout: ProjectLayout, mediaFile: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-edm-export-"));
  temporaryRoots.push(root);
  const projectPath = path.join(root, "project");
  const projectPaths = pathsFor(layout);
  const files: Array<[string, string]> = [
    ["site.json", projectPaths.site],
    ["products.jsonl", projectPaths.productsView],
    ["skus.jsonl", projectPaths.skus],
    ["sku-stock.jsonl", projectPaths.skuStockView],
    [mediaFile, projectPaths.skuMedia],
    ["sku-tags.csv", projectPaths.skuTags],
  ];
  for (const [source, relativeTarget] of files) {
    const target = path.join(projectPath, relativeTarget);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(path.join(FIXTURE, source), target);
  }
  return projectPath;
}

function core(projectPath: string) {
  return createCoreService({
    resolveProject: (id) => id === "synthetic" ? projectPath : path.join(projectPath, "missing"),
    deviceId: "edm-export-test",
    cacheDir: path.join(path.dirname(projectPath), "cache"),
  });
}

async function exportIndex(projectPath: string) {
  const api = core(projectPath);
  const run = api.edm.exportIndex;
  if (!run) throw new Error("Core EDM index export is not registered.");
  return run("synthetic");
}

describe("EDM SKU index export", () => {
  it.each([
    ["legacy", "sku-media-legacy.csv"],
    ["workspace", "sku-media-extended.csv"],
  ] as const)("renders synthetic parent/SKU data in %s layout and reads ledgers without migrating them", async (layout, mediaFile) => {
    const projectPath = await projectFor(layout, mediaFile);
    const projectPaths = pathsFor(layout);
    const mediaPath = path.join(projectPath, projectPaths.skuMedia);
    const tagsPath = path.join(projectPath, projectPaths.skuTags);
    const mediaBefore = await readFile(mediaPath);
    const tagsBefore = await readFile(tagsPath);
    const outputPath = path.join(projectPath, projectPaths.edmSkuIndex);

    const first = await exportIndex(projectPath);
    expect(first).toEqual({
      status: "created",
      path: EDM_SKU_INDEX_PATHS[layout],
      sku_count: 3,
      missing_image_count: 1,
    });
    expect(await readFile(outputPath, "utf8")).toBe(await readFile(path.join(FIXTURE, "sku-index.expected.md"), "utf8"));
    expect(await readFile(mediaPath)).toEqual(mediaBefore);
    expect(await readFile(tagsPath)).toEqual(tagsBefore);

    const outputMtime = (await stat(outputPath)).mtimeMs;
    const repeated = await exportIndex(projectPath);
    expect(repeated).toMatchObject({ status: "unchanged", path: EDM_SKU_INDEX_PATHS[layout], sku_count: 3, missing_image_count: 1 });
    expect((await stat(outputPath)).mtimeMs).toBe(outputMtime);
  });

  it("keeps an unmarked user file byte-for-byte and reports a structured conflict", async () => {
    const projectPath = await projectFor("legacy", "sku-media-legacy.csv");
    const outputPath = path.join(projectPath, pathsFor("legacy").edmSkuIndex);
    const userFile = Buffer.from("# User-maintained EDM list\r\nkeep these bytes exactly\r\n");
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, userFile);

    await expect(exportIndex(projectPath)).rejects.toMatchObject({ code: "EDM_INDEX_CONFLICT" });
    expect(await readFile(outputPath)).toEqual(userFile);
  });

  it("does not replace a changed marked file while conditional update is unavailable", async () => {
    const projectPath = await projectFor("workspace", "sku-media-extended.csv");
    const outputPath = path.join(projectPath, pathsFor("workspace").edmSkuIndex);
    const created = await exportIndex(projectPath);
    expect(created.status).toBe("created");
    const externallyEdited = Buffer.from("<!-- siteindex:generated:edm-sku-index:v1 -->\nexternal change\n");
    await writeFile(outputPath, externallyEdited);

    await expect(exportIndex(projectPath)).rejects.toMatchObject({ code: "EDM_INDEX_CONFLICT" });
    expect(await readFile(outputPath)).toEqual(externallyEdited);
  });

  it("does not overwrite when Core exports contend for the project lock", async () => {
    const projectPath = await projectFor("legacy", "sku-media-legacy.csv");
    const api = core(projectPath);
    const run = api.edm.exportIndex;
    if (!run) throw new Error("Core EDM index export is not registered.");

    const results = await Promise.allSettled([run("synthetic"), run("synthetic")]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled.some((result) => result.value.status === "created")).toBe(true);
    expect(fulfilled.every((result) => result.value.status === "created" || result.value.status === "unchanged")).toBe(true);
    expect(rejected.every((result) => typeof result.reason === "object" && result.reason !== null
      && "code" in result.reason && result.reason.code === "LOCKED")).toBe(true);
    expect(fulfilled.length + rejected.length).toBe(2);
    expect(await readFile(path.join(projectPath, pathsFor("legacy").edmSkuIndex), "utf8"))
      .toBe(await readFile(path.join(FIXTURE, "sku-index.expected.md"), "utf8"));
  });
});
