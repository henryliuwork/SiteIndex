import type { CreateWorkspaceOnlyInput, ProjectDetail, ProjectSummary, SiteIndexApi, SiteIndexError, WorkspaceCreateInput } from "@siteindex/shared";
import { beginRun, categorySeeds, clone, fixtures, mockMode, notifyProjectChanged, projectConfigs, projectIds, projectKey, projectSummaries, projectsChanged, reply, runners, stockSeeds, type MockProjectId } from "./context";
import { createWorkspaceMock, type WorkspaceMock } from "./workspace";

export const mockProjectNonFeedWarnings: Record<MockProjectId, string[]> = { demo: [], demo2: [] };
const demoStoreHost = "demo-store.example.test";

function hasConfiguredFeed(feedUrl: string | string[]): boolean {
  return (Array.isArray(feedUrl) ? feedUrl : [feedUrl]).some((url) => url.trim().length > 0);
}

function normalizeProjectPath(path: string): string {
  return path.trim().replaceAll("/", "\\").replace(/\\+/g, "\\").replace(/\\$/, "").toLocaleLowerCase();
}

function mockProjectIdForPath(normalizedPath: string): string {
  let hash = 2166136261;
  for (let index = 0; index < normalizedPath.length; index += 1) {
    hash = Math.imul(hash ^ normalizedPath.charCodeAt(index), 16777619);
  }
  return "mock-" + (hash >>> 0).toString(36);
}

export function createProjectsMock(workspaceMock: WorkspaceMock = createWorkspaceMock()): SiteIndexApi["projects"] {
  const createdPaths = new Map<string, string>();
  const addedProjects = new Map<string, ProjectDetail>();
  const removedProjectIds = new Set<string>();
  const registeredProjects = () => [
    ...(mockMode === "empty" ? [] : projectIds.map((id) => projectSummaries[id]).filter(({ id }) => !removedProjectIds.has(id))),
    ...[...addedProjects.values()].map(({ summary }) => summary).filter(({ id }) => !removedProjectIds.has(id)),
  ];
  const joinPath = (root: string, folder: string) => {
    const cleanRoot = root.replace(/[\\/]+$/, "");
    return cleanRoot + (root.includes("\\") ? "\\" : "/") + folder;
  };

  return {
    list: () => reply(registeredProjects),
    get: (id) => reply<ProjectDetail>(() => {
      const added = [...addedProjects.values()].find((project) => project.summary.id === id);
      if (added) return added;
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
      const isDemoStore = new URL(baseUrl).hostname.toLowerCase().endsWith(demoStoreHost);
      if (isDemoStore) {
        const finalUrl = `https://${demoStoreHost}`;
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
      if (fixtures.site.domain?.split(".")[0]?.toLowerCase() === "demo-store") return {
        items: 12, usable_skus: 10, products: 8,
        skipped: { duplicate: 1, missing_price_or_link: 1, no_id: 0 },
        stock: { in_stock: 8, out_of_stock: 1, preorder: 0, unknown: 1 },
        field_coverage: [
          { field: opts.sku_field, pct: 100 }, { field: "title", pct: 100 }, { field: "link", pct: 100 },
          { field: "price", pct: 95 }, { field: "availability", pct: 90 }, { field: "image_link", pct: 90 },
          { field: "product_type", pct: 90 }, { field: "item_group_id", pct: 20 }, { field: "sale_price", pct: 10 },
        ],
        category_distribution: [{ slug: "demo-category-1", count: 5 }, { slug: "demo-category-2", count: 3 }, { slug: "demo-category-3", count: 2 }],
        samples: [
          { sku: "DEMO001A01", title: "示例商品 1", variant_title: "样式 1", category: "demo-category-1", price: 12.34, stock_status: "in_stock" },
          { sku: "DEMO001A02", title: "示例商品 1", variant_title: "样式 2", category: "demo-category-1", price: 12.34, stock_status: "in_stock" },
          { sku: "DEMO002A01", title: "示例商品 2", variant_title: null, category: "demo-category-2", price: 23.45, stock_status: "in_stock" },
          { sku: "DEMO003A01", title: "示例商品 3", variant_title: null, category: "demo-category-3", price: 34.56, stock_status: "out_of_stock" },
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
      if (input.workspace?.enabled) {
        workspaceMock.createNow({
          targetDir: path,
          domain: new URL(/^https?:\/\//i.test(input.url) ? input.url : "https://" + input.url).hostname,
          brand: input.brand,
          platform: input.workspace.platform,
          markets: input.markets,
          esp_presets: input.workspace.esp_presets,
        });
      }
      createdPaths.set(id, path);
      return { id, runId: beginRun(path, "init") };
    }),
    createWorkspaceOnly: (input: CreateWorkspaceOnlyInput) => reply(() => {
      const path = joinPath(input.projects_root, input.folder_name);
      const normalizedPath = normalizeProjectPath(path);
      const duplicate = registeredProjects().find((project) => normalizeProjectPath(project.path) === normalizedPath);
      if (duplicate) throw { code: "FOLDER_EXISTS", message: "该位置已经登记了一个项目。" } satisfies SiteIndexError;
      const domain = (() => {
        try { return new URL(/^https?:\/\//i.test(input.url) ? input.url : "https://" + input.url).hostname.toLowerCase(); }
        catch { throw { code: "UNKNOWN", message: "请输入有效的网站地址。" } satisfies SiteIndexError; }
      })();
      const workspaceInput: WorkspaceCreateInput = {
        targetDir: path,
        domain,
        brand: input.brand,
        platform: input.workspace.platform,
        markets: input.markets,
        esp_presets: input.workspace.esp_presets,
      };
      workspaceMock.createNow(workspaceInput);
      const id = mockProjectIdForPath(normalizedPath);
      const source = projectSummaries.demo2;
      const platform: ProjectSummary["platform"] = input.workspace.platform === "magento2" ? "magento" : input.workspace.platform;
      const summary = {
        ...source,
        id,
        name: input.brand.name.trim() || input.folder_name,
        domain,
        platform,
        path,
        sku_count: 0,
        product_count: 0,
        online_rate: null,
        blog_count: 0,
        attention: 0,
        warnings: [],
        sync: { state: "never" as const, at: null, job: null },
        today: { restock: 0, oos: 0, price: 0, new: 0, removed: 0 },
        runner_device: null,
      };
      const config = clone(projectConfigs.demo2);
      config.base_url = /^https?:\/\//i.test(input.url) ? input.url : "https://" + input.url;
      config.domain = domain;
      config.platform = platform;
      config.brand = clone(input.brand);
      config.markets = clone(input.markets);
      addedProjects.set(normalizedPath, { summary, config, runner: runners.demo2 });
      removedProjectIds.delete(id);
      notifyProjectChanged(id);
      return { id };
    }),
    addExisting: (path) => reply<ProjectDetail["summary"]>(() => {
      const trimmedPath = path.trim();
      const normalizedPath = normalizeProjectPath(trimmedPath);
      if (!normalizedPath) throw { code: "PROJECT_UNREADABLE", message: "项目文件夹路径不能为空。" } satisfies SiteIndexError;
      const duplicate = registeredProjects().find((project) => normalizeProjectPath(project.path) === normalizedPath);
      if (duplicate) throw { code: "FOLDER_EXISTS", message: "该项目已添加到项目中心。" } satisfies SiteIndexError;

      const folderName = trimmedPath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "已有项目";
      const slug = folderName.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "existing";
      const id = mockProjectIdForPath(normalizedPath);
      const summary = {
        ...projectSummaries.demo2,
        id,
        name: folderName,
        path: trimmedPath,
        domain: `${slug}.example.test`,
      };
      removedProjectIds.delete(id);
      addedProjects.set(normalizedPath, { summary, config: projectConfigs.demo2, runner: runners.demo2 });
      notifyProjectChanged(id);
      return summary;
    }),
    remove: (id) => reply(() => {
      removedProjectIds.add(id);
      notifyProjectChanged(id);
    }),
    updateConfig: (id, patch) => reply(() => {
      const key = projectKey(id);
      const current = projectConfigs[key];
      const hadFeed = hasConfiguredFeed(current.crawl.feed_url);
      projectConfigs[key] = { ...current, ...clone(patch) };
      const summary = projectSummaries[key];
      const feedUrl = projectConfigs[key].crawl.feed_url;
      const hasFeed = hasConfiguredFeed(feedUrl);
      const feedWarning = "尚未填写 GMC feed 地址，每日库存同步未启用。";
      const warnings = [...mockProjectNonFeedWarnings[key], ...(hasFeed ? [] : [feedWarning])];
      const attention = hasFeed && !hadFeed ? Math.max(0, summary.attention - 1)
        : !hasFeed && hadFeed ? summary.attention + 1 : summary.attention;
      projectSummaries[key] = {
        ...summary,
        domain: patch.domain ?? summary.domain,
        attention,
        warnings: hasFeed ? warnings : [...warnings, feedWarning],
      };
      notifyProjectChanged(id);
      return projectConfigs[key];
    }),
    onChanged: (callback) => { projectsChanged.add(callback); return () => projectsChanged.delete(callback); },
  };
}
