import type { ProjectDetail, SiteIndexApi, SiteIndexError } from "@siteindex/shared";
import { beginRun, categorySeeds, clone, fixtures, mockMode, notifyProjectChanged, projectConfigs, projectIds, projectKey, projectSummaries, projectsChanged, reply, runners, stockSeeds } from "./context";

export function createProjectsMock(): SiteIndexApi["projects"] {
  const createdPaths = new Map<string, string>();
  const joinPath = (root: string, folder: string) => {
    const cleanRoot = root.replace(/[\\/]+$/, "");
    return cleanRoot + (root.includes("\\") ? "\\" : "/") + folder;
  };

  return {
    list: () => reply(() => mockMode === "empty" ? [] : projectIds.map((id) => projectSummaries[id])),
    get: (id) => reply<ProjectDetail>(() => {
      const summary = projectSummaries[projectKey(id)];
      const path = createdPaths.get(id);
      return {
        summary: path ? { ...summary, id, path } : summary,
        config: projectConfigs[projectKey(id)],
        runner: runners[projectKey(id)],
      };
    }),
    detect: (url) => reply(() => {
      const normalized = /^https?:\/\//i.test(url) ? url : "https://" + url;
      const baseUrl = normalized.replace(/\/$/, "");
      const isKingsyard = new URL(baseUrl).hostname.toLowerCase().endsWith("kingsyard.com");
      if (isKingsyard) {
        const finalUrl = "https://www.kingsyard.com";
        return {
          input: url, final_url: finalUrl, redirect_status: 301,
          robots: { found: true, disallow_count: 1, sitemaps: [finalUrl + "/sitemap.xml"] },
          sitemaps: [{ url: finalUrl + "/sitemap.xml", type: "index", url_count: 9 }],
          total_urls: 9, platform: "magento", platform_evidence: "/media/catalog/product/ 图片路径",
          frontend: "Next.js", locale: "en-US", currency: "USD", feed_candidates: [],
        };
      }
      return {
        input: url, final_url: normalized, redirect_status: null,
        robots: { found: true, disallow_count: 0, sitemaps: [baseUrl + "/sitemap.xml"] },
        sitemaps: [{ url: baseUrl + "/sitemap.xml", type: "index", url_count: 1240 }],
        total_urls: 1240, platform: "shopify", platform_evidence: "检测到 Shopify 商品 Feed",
        frontend: "Shopify", locale: "en-US", currency: "USD", feed_candidates: [baseUrl + "/products.json"],
      };
    }),
    inspectFeed: (_feedUrls, opts) => reply(() => {
      if (mockMode === "feed-error") throw { code: "FEED_FETCH_FAILED", message: "无法读取 Feed，请检查地址后重试。" } satisfies SiteIndexError;
      if (fixtures.site.domain === "kingsyard.com") return {
        items: 20, usable_skus: 18, products: 16,
        skipped: { duplicate: 1, missing_price_or_link: 1, no_id: 0 },
        stock: { in_stock: 16, out_of_stock: 1, preorder: 0, unknown: 1 },
        field_coverage: [
          { field: opts.sku_field, pct: 100 }, { field: "title", pct: 100 }, { field: "link", pct: 100 },
          { field: "price", pct: 95 }, { field: "availability", pct: 90 }, { field: "image_link", pct: 90 },
          { field: "product_type", pct: 90 }, { field: "item_group_id", pct: 20 }, { field: "sale_price", pct: 10 },
        ],
        category_distribution: [{ slug: "bird-feeders", count: 10 }, { slug: "bird-houses", count: 4 }, { slug: "bird-baths", count: 4 }],
        samples: [
          { sku: "KYBF000-G", title: "Kingsyard Feeder 0 & Co", variant_title: "Green", category: "bird-feeders", price: 19.99, stock_status: "in_stock" },
          { sku: "KYBF000-R", title: "Kingsyard Feeder 0 & Co", variant_title: "Red", category: "bird-feeders", price: 19.99, stock_status: "in_stock" },
          { sku: "KYBF002", title: "Kingsyard Feeder 2 & Co", variant_title: null, category: "bird-houses", price: 16.99, stock_status: "in_stock" },
          { sku: "KYBF003", title: "Kingsyard Feeder 3 & Co", variant_title: null, category: "bird-baths", price: 22.99, stock_status: "out_of_stock" },
        ],
      };
      return {
        items: fixtures.skus.length, usable_skus: fixtures.skus.length, products: fixtures.products.length,
        skipped: { duplicate: 0, missing_price_or_link: 0, no_id: 0 },
        stock: { in_stock: fixtures.stock.filter((row) => row.stock_status === "in_stock").length, out_of_stock: 1, preorder: 0, unknown: 1 },
        field_coverage: [{ field: opts.sku_field, pct: 100 }, { field: "title", pct: 100 }, { field: "price", pct: 100 }],
        category_distribution: categorySeeds.map((category) => ({ slug: category.slug, count: category.product_count ?? 0 })),
        samples: fixtures.skus.slice(0, 5).map((row) => ({
          sku: row.sku, title: row.title, variant_title: row.variant_title, category: row.category,
          price: row.price, stock_status: stockSeeds.get(row.sku)?.stock_status ?? "in_stock",
        })),
      };
    }),
    create: (input) => reply(() => {
      const id = input.folder_name || "new-project";
      const path = joinPath(input.projects_root, input.folder_name);
      createdPaths.set(id, path);
      return { id, runId: beginRun(path, "init") };
    }),
    addExisting: () => reply(projectSummaries.riverstone),
    updateConfig: (id, patch) => reply(() => {
      const key = projectKey(id);
      const current = projectConfigs[key];
      projectConfigs[key] = { ...current, ...clone(patch) };
      if (patch.domain) projectSummaries[key] = { ...projectSummaries[key], domain: patch.domain };
      notifyProjectChanged(id);
      return projectConfigs[key];
    }),
    onChanged: (callback) => { projectsChanged.add(callback); return () => projectsChanged.delete(callback); },
  };
}
