import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PATHS } from "@siteindex/shared";
import { afterEach, describe, expect, it } from "vitest";
import { createCoreService } from "../src/service";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("EDM gallery URLs", () => {
  it("keeps the chosen main image first and omits a missing gallery for legacy projects", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-edm-gallery-"));
    roots.push(root);
    const project = path.join(root, "demo");
    await cp(path.resolve("fixtures/expected/project"), project, { recursive: true });
    const fixture = path.resolve("fixtures/woocommerce-v065");
    const product = JSON.parse(await readFile(path.join(fixture, "store-api-products.json"), "utf8")) as
      { slug: string; sku: string; images: { src: string }[] }[];
    const main = product[0]!.images[0]!.src;
    const side = "https://shop.example.test/media/sample-lamp-side.jpg";
    await writeFile(path.join(project, PATHS.skus), JSON.stringify({
      sku: product[0]!.sku, handle: product[0]!.slug, title: "Demo lamp", variant_title: null,
      status: "active", image_url: main,
    }) + "\n");
    await writeFile(path.join(project, PATHS.inventoryLatest), JSON.stringify({
      sku: product[0]!.sku, stock_status: "in_stock",
    }) + "\n");
    await writeFile(path.join(project, PATHS.productDetails), JSON.stringify({
      handle: product[0]!.slug, gallery: [main, side, "javascript:alert(1)", side],
    }) + "\n");
    const api = createCoreService({ resolveProject: () => project, deviceId: "gallery-test", cacheDir: path.join(root, "cache") });
    const query = { page: 1, pageSize: 20 } as const;
    const row = (await api.edm.listImages("demo", query)).rows[0]!;
    expect(row).toMatchObject({ feed_image_url: main, manual_image_url: null, used: "feed", gallery_urls: [main, side] });

    await writeFile(path.join(project, PATHS.productDetails), "");
    api.invalidate(project);
    expect((await api.edm.listImages("demo", query)).rows[0]?.gallery_urls).toBeUndefined();
  }, 30_000);
});
