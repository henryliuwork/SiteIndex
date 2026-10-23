import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PATHS } from "@siteindex/shared";
import { afterEach, describe, expect, it } from "vitest";
import { createCoreService } from "../src/service";
import { readJsonl, writeJsonl, type JsonRecord } from "../src/io/jsonl";

const FIXTURE_PROJECT = path.resolve(process.cwd(), "fixtures/expected/project");
const TEMP_DIRS: string[] = [];

async function makeProject(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-categories-"));
  TEMP_DIRS.push(root);
  const projectPath = path.join(root, "project");
  await cp(FIXTURE_PROJECT, projectPath, { recursive: true });
  return projectPath;
}

function service(projectPath: string) {
  return createCoreService({
    resolveProject: () => projectPath,
    deviceId: "test-device",
    cacheDir: path.join(path.dirname(projectPath), "cache"),
  });
}

async function useSingleSku(projectPath: string, url: string): Promise<JsonRecord> {
  const rows = await readJsonl(path.join(projectPath, PATHS.skus));
  const sku = rows.find((row) => row.sku === "KYBF000-G");
  if (!sku) throw new Error("Fixture SKU KYBF000-G is missing");
  sku.url = url;
  sku.category = "bird-feeders";
  sku.categories = ["bird-feeders"];
  await writeJsonl(path.join(projectPath, PATHS.skus), [sku], "sku");
  return sku;
}

async function writeSeoData(projectPath: string, pages: JsonRecord[], links: JsonRecord[] = []): Promise<void> {
  await mkdir(path.dirname(path.join(projectPath, PATHS.seoPages)), { recursive: true });
  await writeFile(path.join(projectPath, PATHS.seoPages), pages.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
  await writeFile(path.join(projectPath, PATHS.seoLinks), links.map((row) => JSON.stringify(row)).join("\n") + (links.length ? "\n" : ""), "utf8");
}

async function readCatalogCategories(projectPath: string): Promise<JsonRecord[]> {
  return JSON.parse(await readFile(path.join(projectPath, PATHS.categories), "utf8")) as JsonRecord[];
}

afterEach(async () => {
  await Promise.all(TEMP_DIRS.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("core category preview and apply", () => {
  it("previews feed categories without writing and applies every feed category", async () => {
    const projectPath = await makeProject();
    const api = service(projectPath);
    const sku = await useSingleSku(projectPath, "https://shop.example/products/feeder-0");
    sku.categories = ["bird-feeders", "tube-feeders"];
    await writeJsonl(path.join(projectPath, PATHS.skus), [sku], "sku");
    await writeSeoData(projectPath, [{
      url: "https://shop.example/collections/bird-feeders", page_type: "collection", h1: "Bird Feeders",
    }]);
    const originalSkuFile = await readFile(path.join(projectPath, PATHS.skus), "utf8");

    const preview = await api.categories.preview("fixture", { mode: "feed" });

    expect(preview).toMatchObject({ uncategorized: 0, multi_matched: 1 });
    expect(preview.categories).toEqual([
      { slug: "bird-feeders", name: "Bird Feeders", url: "https://shop.example/collections/bird-feeders", sku_count: 1 },
      { slug: "tube-feeders", name: "tube-feeders", url: "", sku_count: 1 },
    ]);
    expect(preview.candidates).toEqual([{
      url: "https://shop.example/collections/bird-feeders", product_links: 0, configured: true,
    }]);
    expect(await readFile(path.join(projectPath, PATHS.skus), "utf8")).toBe(originalSkuFile);

    const applied = await api.categories.save("fixture", { mode: "feed" });
    const savedSkus = await readJsonl(path.join(projectPath, PATHS.skus));
    expect(applied).toEqual(preview);
    expect(savedSkus[0]).toMatchObject({ category: "bird-feeders", categories: ["bird-feeders", "tube-feeders"], category_source: "feed" });
    expect(await readCatalogCategories(projectPath)).toEqual(expect.arrayContaining([
      expect.objectContaining({ slug: "bird-feeders", source: "feed", sku_count: 1, product_count: 1 }),
      expect.objectContaining({ slug: "tube-feeders", source: "feed", sku_count: 1, product_count: 1 }),
    ]));
  }, 60_000);

  it("matches url_rule prefixes on product URLs and applies the matching collection page", async () => {
    const projectPath = await makeProject();
    const api = service(projectPath);
    const productUrl = "https://shop.example/collections/bird-feeders/products/feeder-0?variant=green";
    await useSingleSku(projectPath, productUrl);
    await writeSeoData(projectPath, [
      { url: "https://shop.example/collections/bird-feeders", page_type: "collection", h1: "Bird Feeders" },
      { url: "https://shop.example/pages/about", page_type: "collection", h1: "About" },
    ], [{ from: "https://shop.example/collections/bird-feeders", to: "https://shop.example/products/feeder-0", to_type: "product" }]);
    const config = { mode: "url_rule" as const, url_pattern: "/collections/{slug}" };

    const preview = await api.categories.preview("fixture", config);
    const applied = await api.categories.save("fixture", config);
    const savedSku = (await readJsonl(path.join(projectPath, PATHS.skus)))[0];

    expect(preview.categories).toEqual([{
      slug: "bird-feeders", name: "Bird Feeders", url: "https://shop.example/collections/bird-feeders", sku_count: 1,
    }]);
    expect(preview.candidates).toEqual([
      { url: "https://shop.example/collections/bird-feeders", product_links: 1, configured: true },
      { url: "https://shop.example/pages/about", product_links: 0, configured: false },
    ]);
    expect(applied).toEqual(preview);
    expect(savedSku).toMatchObject({ category: "bird-feeders", categories: ["bird-feeders"], category_source: "url_rule" });
    expect(await readCatalogCategories(projectPath)).toContainEqual(expect.objectContaining({
      slug: "bird-feeders", name: "Bird Feeders", url: "https://shop.example/collections/bird-feeders", source: "url_rule", sku_count: 1,
    }));
  }, 60_000);

  it("keeps manual rule order, reports overlaps, and applies only the first match", async () => {
    const projectPath = await makeProject();
    const api = service(projectPath);
    await useSingleSku(projectPath, "https://shop.example/products/feeder-0");
    await writeSeoData(projectPath, [{ url: "https://shop.example/collections/featured", page_type: "collection", h1: "Featured Feeders" }]);
    const config = {
      mode: "manual" as const,
      manual: [
        { slug: "featured", name: "Featured Feeders", url: "https://shop.example/collections/featured", match: [{ type: "sku_prefix" as const, value: "KYBF000" }] },
        { slug: "all-feeders", name: "All Feeders", url: "", match: [{ type: "skus" as const, value: "KYBF000-G|KYBF000-R" }] },
      ],
    };

    const preview = await api.categories.preview("fixture", config);
    const applied = await api.categories.save("fixture", config);
    const savedSku = (await readJsonl(path.join(projectPath, PATHS.skus)))[0];
    const savedCategories = await readCatalogCategories(projectPath);

    expect(preview).toMatchObject({ uncategorized: 0, multi_matched: 1 });
    expect(preview.categories).toEqual([
      { slug: "all-feeders", name: "All Feeders", url: "", sku_count: 0 },
      { slug: "featured", name: "Featured Feeders", url: "https://shop.example/collections/featured", sku_count: 1 },
    ]);
    expect(preview.candidates).toEqual([
      { url: "https://shop.example/collections/featured", product_links: 0, configured: true },
    ]);
    expect(applied).toEqual(preview);
    expect(savedSku).toMatchObject({ category: "featured", categories: ["featured"], category_source: "manual" });
    expect(savedCategories).toEqual(expect.arrayContaining([
      expect.objectContaining({ slug: "featured", source: "manual", sku_count: 1, product_count: 1 }),
      expect.objectContaining({ slug: "all-feeders", source: "manual", sku_count: 0, product_count: 0 }),
    ]));
  }, 60_000);
});
