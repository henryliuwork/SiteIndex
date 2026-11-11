import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EDM_SKU_INDEX_PATHS, pathsFor, type ProductView, type ProjectLayout, type SiteConfig, type SkuRecord, type SkuStockView } from "@siteindex/shared";
import { afterEach, describe, expect, it } from "vitest";
import { parseCsv } from "../src/io/csv";
import { createEdmSkuIndexFile, renderEdmSkuIndex, type EdmSkuIndexInput } from "../src/edm/sku-index";
import { createCoreService } from "../src/service";

const FIXTURE = path.resolve(process.cwd(), "fixtures/a-v041-edm-export");
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function parseJsonl<T>(source: string): T[] {
  return source.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as T);
}

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

async function fixtureInput(layout: ProjectLayout, mediaFile: string): Promise<EdmSkuIndexInput> {
  const [productsText, skusText, stockText, siteText, mediaText, tagsText] = await Promise.all([
    readFile(path.join(FIXTURE, "products.jsonl"), "utf8"),
    readFile(path.join(FIXTURE, "skus.jsonl"), "utf8"),
    readFile(path.join(FIXTURE, "sku-stock.jsonl"), "utf8"),
    readFile(path.join(FIXTURE, "site.json"), "utf8"),
    readFile(path.join(FIXTURE, mediaFile), "utf8"),
    readFile(path.join(FIXTURE, "sku-tags.csv"), "utf8"),
  ]);
  const site = JSON.parse(siteText) as SiteConfig;
  return {
    products: parseJsonl<ProductView>(productsText),
    skus: parseJsonl<SkuRecord>(skusText),
    stock: parseJsonl<SkuStockView>(stockText),
    skuMedia: parseCsv(mediaText, mediaFile),
    skuTags: parseCsv(tagsText, "sku-tags.csv"),
    grouping: site.sku_grouping,
  };
}

async function renderFixture(layout: ProjectLayout, mediaFile: string) {
  return renderEdmSkuIndex(await fixtureInput(layout, mediaFile));
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

async function fileExists(filePath: string): Promise<boolean> {
  try { await stat(filePath); return true; }
  catch { return false; }
}

describe("EDM SKU index rendering", () => {
  it.each([
    ["legacy", "sku-media-legacy.csv"],
    ["workspace", "sku-media-extended.csv"],
  ] as const)("renders the synthetic %s layout deterministically without migrating ledgers", async (layout, mediaFile) => {
    const result = await renderFixture(layout, mediaFile);
    expect(result).toEqual({
      content: await readFile(path.join(FIXTURE, "sku-index.expected.md"), "utf8"),
      skuCount: 3,
      missingImageCount: 1,
    });
  });

  it("marks unrecognized product and image query values for review instead of emitting stripped URLs", async () => {
    const input = await fixtureInput("legacy", "sku-media-legacy.csv");
    const productsText = await readFile(path.join(FIXTURE, "products.jsonl"), "utf8");
    const skusText = await readFile(path.join(FIXTURE, "skus.jsonl"), "utf8");
    const products = parseJsonl<ProductView>(productsText).map((product) => product.product_id === "PRODUCT-SINGLE"
      ? {
        ...product,
        url: "https://synthetic-edm.test/products/item?color=secret-under-safe-key&username=secret-user&session=secret-session&sig=secret-sig&s%65ssion=encoded-secret&%75sername=encoded-user&%73ig=encoded-sig&%61ccess_token=secret-token&size=small#private-fragment",
      }
      : product);
    const skus = parseJsonl<SkuRecord>(skusText).map((sku) => sku.sku === "DEMO-SINGLE"
      ? { ...sku, image_url: "https://synthetic-cdn.invalid/images/demo-single.png?color=secret-image-value" }
      : sku);
    const result = renderEdmSkuIndex({ ...input, products, skus });

    expect(result.content).toContain("链接待确认（原链接含未识别参数）");
    expect(result.content).toContain("待补图（原图片链接含未识别参数）");
    expect(result.content).not.toMatch(/secret-under-safe-key|secret-user|secret-session|secret-sig|encoded-secret|encoded-user|encoded-sig|secret-token|secret-image-value|private-fragment/u);
    expect(result.missingImageCount).toBe(2);
  });

  it("preserves a variant selector only when it exactly matches an exported SKU", async () => {
    const input = await fixtureInput("legacy", "sku-media-legacy.csv");
    const productsText = await readFile(path.join(FIXTURE, "products.jsonl"), "utf8");
    const products = parseJsonl<ProductView>(productsText).map((product) => product.product_id === "PRODUCT-SINGLE"
      ? { ...product, url: "https://synthetic-edm.test/products/item?gclid=tracking-id&variant=DEMO-SINGLE&utm_source=fixture" }
      : product);
    const result = renderEdmSkuIndex({ ...input, products });

    expect(result.content).toContain("https://synthetic-edm.test/products/item?variant=DEMO-SINGLE |");
    expect(result.content).not.toContain("tracking-id");
    expect(result.content).not.toContain("utm_source");
  });

  it("marks an unrecognized variant selector for review", async () => {
    const input = await fixtureInput("legacy", "sku-media-legacy.csv");
    const productsText = await readFile(path.join(FIXTURE, "products.jsonl"), "utf8");
    const products = parseJsonl<ProductView>(productsText).map((product) => product.product_id === "PRODUCT-SINGLE"
      ? { ...product, url: "https://synthetic-edm.test/products/item?variant=not-a-feed-sku" }
      : product);
    const result = renderEdmSkuIndex({ ...input, products });

    expect(result.content).toContain("链接待确认（原链接含未识别参数）");
    expect(result.content).not.toContain("not-a-feed-sku");
  });

  it("renders an empty inventory with exactly one final newline", async () => {
    const input = await fixtureInput("legacy", "sku-media-legacy.csv");
    const result = renderEdmSkuIndex({ ...input, products: [] });
    expect(result.content).toBe([
      "<!-- siteindex:generated:edm-sku-index:v1 -->",
      "# EDM SKU Index",
      "",
      "| SKU | 标题 | 短描述 | URL | 图片 URL | 原价 | 折扣价 | 库存 |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
      "",
    ].join("\n"));
    expect(result.content.endsWith("\n\n")).toBe(false);
  });
});

describe("EDM SKU index safe file boundary", () => {
  it.each([
    ["legacy", "sku-media-legacy.csv"],
    ["workspace", "sku-media-extended.csv"],
  ] as const)("refuses to create in %s when no bound-directory no-follow writer exists", async (layout, mediaFile) => {
    const projectPath = await projectFor(layout, mediaFile);
    const paths = pathsFor(layout);
    const output = path.join(projectPath, paths.edmSkuIndex);

    await expect(exportIndex(projectPath)).rejects.toMatchObject({ code: "EDM_INDEX_CONFLICT" });
    expect(await fileExists(output)).toBe(false);
    expect(await fileExists(path.dirname(output))).toBe(false);
  });

  it("does not write outside the project when an ancestor becomes a junction after validation", async () => {
    const projectPath = await projectFor("legacy", "sku-media-legacy.csv");
    const parent = path.join(projectPath, path.dirname(pathsFor("legacy").edmSkuIndex));
    const movedParent = `${parent}.moved`;
    const outside = path.join(path.dirname(projectPath), "outside-target");
    await mkdir(parent, { recursive: true });
    await mkdir(outside, { recursive: true });
    const sentinel = path.join(outside, "sentinel.txt");
    const sentinelBytes = Buffer.from("keep external bytes\n");
    await writeFile(sentinel, sentinelBytes);

    await expect(createEdmSkuIndexFile(projectPath, "legacy", "generated\n", {
      afterPathValidation: async () => {
        await rename(parent, movedParent);
        await symlink(outside, parent, process.platform === "win32" ? "junction" : "dir");
      },
    })).rejects.toMatchObject({ code: "EDM_INDEX_CONFLICT" });

    expect(await readFile(sentinel)).toEqual(sentinelBytes);
    expect(await readdir(outside)).toEqual(["sentinel.txt"]);
    await rm(parent, { recursive: true, force: true });
    await rename(movedParent, parent);
  });

  it("preserves an external creator that wins after validation", async () => {
    const projectPath = await projectFor("workspace", "sku-media-extended.csv");
    const output = path.join(projectPath, pathsFor("workspace").edmSkuIndex);
    await mkdir(path.dirname(output), { recursive: true });
    const externalBytes = Buffer.from("external first creator\n");

    await expect(createEdmSkuIndexFile(projectPath, "workspace", "generated\n", {
      afterPathValidation: async () => writeFile(output, externalBytes, { flag: "wx" }),
    })).rejects.toMatchObject({ code: "EDM_INDEX_CONFLICT" });

    expect(await readFile(output)).toEqual(externalBytes);
  });

  it("fails closed when the filesystem has no safe hard-link/no-follow capability", async () => {
    const projectPath = await projectFor("legacy", "sku-media-legacy.csv");
    const output = path.join(projectPath, pathsFor("legacy").edmSkuIndex);

    await expect(createEdmSkuIndexFile(projectPath, "legacy", "generated\n"))
      .rejects.toMatchObject({ code: "EDM_INDEX_CONFLICT" });
    expect(await fileExists(output)).toBe(false);
    expect(await readdir(path.join(projectPath, "index"))).not.toContain("edm");
  });

  it("preserves unmarked and externally edited existing files", async () => {
    for (const [layout, mediaFile] of [
      ["legacy", "sku-media-legacy.csv"],
      ["workspace", "sku-media-extended.csv"],
    ] as const) {
      const projectPath = await projectFor(layout, mediaFile);
      const output = path.join(projectPath, pathsFor(layout).edmSkuIndex);
      await mkdir(path.dirname(output), { recursive: true });
      const bytes = Buffer.from(layout === "legacy"
        ? "# user-maintained list\r\nkeep these bytes\r\n"
        : "<!-- siteindex:generated:edm-sku-index:v1 -->\nexternal edit\n");
      await writeFile(output, bytes);

      await expect(exportIndex(projectPath)).rejects.toMatchObject({ code: "EDM_INDEX_CONFLICT" });
      expect(await readFile(output)).toEqual(bytes);
    }
  });
});
