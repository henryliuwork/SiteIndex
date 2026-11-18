import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PATHS, type SiteConfig } from "@siteindex/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readJsonl } from "../src/io/jsonl";
import { runWeekly } from "../src/jobs/weekly";
import { createCoreService } from "../src/service";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("WooCommerce weekly blog and gallery fallback", () => {
  it("paginates WordPress posts without a blog Sitemap and records product links, schema and stock", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-woo-blog-v064-"));
    roots.push(root);
    const project = path.join(root, "demo");
    await cp(path.resolve("fixtures/expected/project"), project, { recursive: true });
    const fixture = path.resolve("fixtures/woocommerce-v065");
    const base = "https://shop.example.test";
    const config = JSON.parse(await readFile(path.join(project, PATHS.site), "utf8")) as SiteConfig;
    config.platform = "woocommerce";
    config.base_url = base;
    config.sitemaps = [`${base}/product-sitemap.xml`, `${base}/page-sitemap.xml`];
    config.content = undefined;
    config.crawl.rate_limit_ms = 0;
    config.categories = { mode: "manual", manual: [{ slug: "lighting", name: "Lighting", url: `${base}/shop/lighting/`, match: [] }] };
    await writeFile(path.join(project, PATHS.skus), [
      { sku: "DEMO-WC-LAMP", handle: "sample-lamp", url: `${base}/product/sample-lamp/` },
      { sku: "DEMO-WC-KIT", handle: "sample-kit", url: `${base}/product/sample-kit/` },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n");
    await writeFile(path.join(project, PATHS.inventoryLatest), [
      { sku: "DEMO-WC-LAMP", stock_status: "in_stock" },
      { sku: "DEMO-WC-KIT", stock_status: "out_of_stock" },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n");
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      calls.push(url.pathname + url.search);
      if (url.pathname === "/wp-json/wp/v2/posts") {
        const link = url.searchParams.get("page") === "1" ? `${base}/journal/sample-post/` : `${base}/journal/second-note/`;
        return new Response(JSON.stringify([{ link }]), { headers: { "x-wp-totalpages": "2" } });
      }
      if (url.pathname === "/wp-json/wc/store/v1/products") {
        const products = JSON.parse(await readFile(path.join(fixture, "store-api-products.json"), "utf8")) as
          { slug: string; images: { src: string }[] }[];
        products[0]!.images.push({ src: `${base}/media/sample-lamp-api-side.jpg` });
        return new Response(JSON.stringify(products), { headers: { "x-wp-totalpages": "1" } });
      }
      if (url.pathname === "/product-sitemap.xml")
        return new Response(await readFile(path.join(fixture, "product-sitemap.xml"), "utf8"));
      if (url.pathname === "/page-sitemap.xml")
        return new Response(`<urlset><url><loc>${base}/journal/dom-only/</loc></url></urlset>`);
      if (url.pathname === "/product/sample-lamp/") {
        const html = (await readFile(path.join(fixture, "product-page.html"), "utf8"))
          .replace('src="https://shop.example.test/media/sample-lamp.jpg"',
            'data-large_image="https://shop.example.test/media/sample-lamp-full.jpg" src="https://shop.example.test/media/sample-lamp-thumb.jpg"')
          .replace('alt="Sample lamp"></div>',
            `alt="Sample lamp"><img data-large_image="${base}/media/sample-lamp-side.jpg" src="${base}/media/side-thumb.jpg"></div>`);
        return new Response(html);
      }
      if (url.pathname === "/product/sample-kit/")
        return new Response(`<html><title>Sample kit</title><body><h1>Sample kit</h1><div class="woocommerce-product-gallery"><img src="${base}/media/kit.jpg"></div><p class="price">$25</p></body></html>`);
      if (url.pathname === "/journal/sample-post/") {
        const html = (await readFile(path.join(fixture, "blog-page.html"), "utf8"))
          .replace("</article>", `<a href="/product/sample-kit/">kit</a></article>`);
        return new Response(html);
      }
      if (url.pathname === "/journal/second-note/")
        return new Response(`<html><title>Second note</title><body class="single-post"><article class="post type-post"><h1>Second note</h1><a href="/product/sample-kit/">kit</a></article></body></html>`);
      if (url.pathname === "/journal/dom-only/")
        return new Response(`<html><title>DOM only</title><body class="single-post"><article class="post type-post"><h1>DOM only</h1><a href="/product/sample-kit/">kit</a></article></body></html>`);
      return new Response("missing", { status: 404 });
    }));

    const result = await runWeekly(project, config, { date: "2026-11-18" });
    expect(result.counts.blog, JSON.stringify(result)).toBe(3);
    expect(calls.filter((call) => call.startsWith("/wp-json/wp/v2/posts"))).toHaveLength(2);
    const blogs = await readJsonl(path.join(project, PATHS.blogIndex));
    expect(blogs.map((row) => row.slug)).toEqual(["dom-only", "sample-post", "second-note"]);
    expect(blogs.find((row) => row.slug === "sample-post"))
      .toMatchObject({ links_products: ["sample-kit", "sample-lamp"], linked_out_of_stock: ["sample-kit"] });
    expect(blogs.find((row) => row.slug === "dom-only"))
      .toMatchObject({ links_products: ["sample-kit"], linked_out_of_stock: ["sample-kit"] });
    const service = createCoreService({ resolveProject: () => project, deviceId: "woo-blog-test", cacheDir: path.join(root, "cache") });
    expect((await service.content.summary("demo")).kpis.find((item) => item.key === "links_oos")?.value).toBe("3");
    const pages = await readJsonl(path.join(project, PATHS.seoPages));
    expect(pages.find((row) => row.url === `${base}/journal/second-note/`)).toMatchObject({ page_type: "blog", schema_types: [] });
    expect(pages.find((row) => row.url === `${base}/journal/dom-only/`)).toMatchObject({ page_type: "blog", schema_types: [] });
    const issues = await readJsonl(path.join(project, PATHS.seoIssues));
    expect(issues.some((row) => row.url === `${base}/journal/second-note/` && row.rule === "schema_missing")).toBe(true);
    expect(issues.some((row) => row.url === `${base}/journal/sample-post/` && row.rule === "schema_missing")).toBe(false);
    const links = await readJsonl(path.join(project, PATHS.seoLinks));
    expect(links.find((row) => row.from === `${base}/journal/second-note/` && row.to === `${base}/product/sample-kit/`))
      .toMatchObject({ to_type: "product" });
    const details = await readJsonl(path.join(project, PATHS.productDetails));
    expect(details.find((row) => row.handle === "sample-lamp")?.gallery).toEqual([
      `${base}/media/sample-lamp-full.jpg`, `${base}/media/sample-lamp-side.jpg`,
      `${base}/media/sample-lamp.jpg`, `${base}/media/sample-lamp-api-side.jpg`,
    ]);
  }, 30_000);
});
