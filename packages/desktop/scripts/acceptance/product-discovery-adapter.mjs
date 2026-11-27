import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyProductDiscoveryRoutes, PRODUCT_DISCOVERY_ROUTES } from "./product-discovery-routes.mjs";
import { waitForObserved } from "./session.mjs";

const PROJECT_ID = "matrix-86";
const FIXTURE_ROOT = new URL("../../../../fixtures/woocommerce-v065/", import.meta.url);
const LOOPBACK_SCRIPT = fileURLToPath(new URL("loopback-server.mjs", FIXTURE_ROOT));

function mismatch(message) {
  const error = new Error(message);
  error.acceptanceStatus = "assertion_failed";
  return error;
}

async function rows(file) {
  const content = await readFile(file, "utf8");
  return content.trim() ? content.trim().split(/\r?\n/u).map((line) => JSON.parse(line)) : [];
}

async function startLoopback(profile) {
  await verifyProductDiscoveryRoutes(FIXTURE_ROOT);
  const workDir = path.join(profile.root, "product-discovery-loopback");
  await mkdir(workDir, { recursive: true });
  const child = spawn(process.execPath, [LOOPBACK_SCRIPT, workDir], {
    cwd: profile.root, windowsHide: true, stdio: "ignore",
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: profile.layout.tempRoot },
  });
  child.on("error", () => undefined);
  let port;
  try {
    port = await waitForObserved(async () => {
      if (child.exitCode !== null) throw new Error("Synthetic loopback exited before startup");
      const value = await readFile(path.join(workDir, "port.txt"), "utf8").catch(() => "");
      const parsed = Number(value.trim());
      return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
    }, { timeoutMs: 15_000, label: "synthetic product discovery loopback" });
  } catch (error) {
    child.kill();
    throw error;
  }
  return {
    origin: `http://127.0.0.1:${port}`,
    async metrics() {
      return JSON.parse(await readFile(path.join(workDir, "requests.json"), "utf8"));
    },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill();
      await waitForObserved(() => child.exitCode !== null || child.signalCode !== null,
        { timeoutMs: 5_000, label: "synthetic loopback cleanup" });
    },
  };
}

export async function createProductDiscoveryFixture(profile, origin, deviceId) {
  const projectDir = path.join(profile.layout.projectRoot, PROJECT_ID);
  const indexDir = path.join(projectDir, "index");
  await mkdir(indexDir, { recursive: true });
  const disabled = () => ({ enabled: false, days: [], time: "00:00" });
  const site = {
    schema_version: "1.0", domain: "127.0.0.1", base_url: origin, platform: "woocommerce",
    currency: "USD", locale: "en-US", timezone: "UTC", markets: ["US"],
    brand: { name: "Synthetic product discovery" },
    sitemaps: [`${origin}${PRODUCT_DISCOVERY_ROUTES.sitemap}`],
    crawl: { adapter: "gmc_feed", feed_url: [`${origin}${PRODUCT_DISCOVERY_ROUTES.feed}`],
      sku_field: "id", rate_limit_ms: 0, max_pages: 20, auto_collect_products: false },
    categories: { mode: "feed" }, workspace_folders: [],
    schedule: { daily: disabled(), validate: disabled(), weekly: disabled(), readme: disabled(),
      monthly: { ...disabled(), day_of_month: 1 },
      options: { wake_to_run: false, run_if_missed: false, notify_on_failure: false, validate_after_sync: false } },
  };
  await writeFile(path.join(indexDir, "site.json"), `${JSON.stringify(site, null, 2)}\n`, "utf8");
  await writeFile(path.join(indexDir, ".runner.json"), `${JSON.stringify({ device_id: deviceId,
    device_name: "Synthetic runner", claimed_at: "2026-11-27T00:00:00.000Z" })}\n`, "utf8");
  return { projectId: PROJECT_ID, projectDir, indexDir };
}

async function runJob(page, projectPath, job) {
  return page.evaluate(async ({ projectPath, job }) => {
    const finished = [];
    let resolveFinished;
    const unsubscribe = window.siteindex.jobs.onFinished((result) => {
      finished.push(result);
      if (result.runId === runId) resolveFinished?.(result);
    });
    let runId = "";
    let timeout;
    try {
      const started = await window.siteindex.jobs.run({ projectPath, job, date: "2026-11-27",
        ...(job === "weekly" ? { only: "pages" } : {}) });
      runId = started.runId;
      return finished.find((result) => result.runId === runId) ?? await new Promise((resolve, reject) => {
        resolveFinished = resolve;
        timeout = setTimeout(() => reject(new Error(`Installed ${job} did not finish`)), 180_000);
      });
    } finally { clearTimeout(timeout); unsubscribe(); }
  }, { projectPath, job });
}

export async function ipcCatalog(page) {
  return page.evaluate(async (id) => {
    const query = { page: 1, pageSize: 50, filters: {} };
    const [products, stock] = await Promise.all([
      window.siteindex.products.list(id, query), window.siteindex.inventory.listSkus(id, query),
    ]);
    return { productSkus: products.rows.flatMap((item) => item.skus),
      stock: stock.rows.map((item) => ({ sku: item.sku, status: item.stock_status })) };
  }, PROJECT_ID);
}

export function productDiscoveryAdapter() {
  let loopback;
  let fixture;
  let baselineFeedSkus;
  let baselineTraffic;
  let candidateTraffic;
  const inspectFiles = async () => {
    if (!fixture) throw new Error("Synthetic discovery fixture is missing");
    const skus = await rows(path.join(fixture.indexDir, "catalog", "skus.jsonl"));
    const stock = await rows(path.join(fixture.indexDir, "inventory", "latest.jsonl"));
    const products = await rows(path.join(fixture.indexDir, "views", "products.jsonl"));
    return { skus, stock, products };
  };
  const checkBaseline = async (page) => {
    const ipc = await ipcCatalog(page);
    if (!ipc.productSkus.includes(PRODUCT_DISCOVERY_ROUTES.feedSku)
      || ipc.productSkus.includes(PRODUCT_DISCOVERY_ROUTES.sitemapOnlySku)) {
      throw mismatch("Official baseline did not isolate the Feed-only product");
    }
  };
  const checkCandidate = async (page) => {
    const ipc = await ipcCatalog(page);
    if (!ipc.productSkus.includes(PRODUCT_DISCOVERY_ROUTES.feedSku)
      || !ipc.productSkus.includes(PRODUCT_DISCOVERY_ROUTES.sitemapOnlySku)
      || ipc.stock.find((item) => item.sku === PRODUCT_DISCOVERY_ROUTES.sitemapOnlySku)?.status !== "unknown") {
      throw mismatch("Installed candidate did not expose the page-discovered SKU with unverified inventory");
    }
  };
  return {
    reportEvidence: () => ({ feed_sku: PRODUCT_DISCOVERY_ROUTES.feedSku,
      sitemap_only_sku: PRODUCT_DISCOVERY_ROUTES.sitemapOnlySku, candidate_stock: "unknown",
      baseline_requests: baselineTraffic?.total ?? null, candidate_requests: candidateTraffic?.total ?? null }),
    async baselineUi({ page, profile, noteIpc }) {
      loopback = await startLoopback(profile);
      noteIpc({ operation: "settings.set/projects.addExisting", itemId: 86 });
      const settings = await page.evaluate(async (root) => {
        await window.siteindex.settings.set({ projects_root: root, close_to_tray: false });
        return window.siteindex.settings.get();
      }, profile.layout.projectRoot);
      fixture = await createProductDiscoveryFixture(profile, loopback.origin, settings.device_id);
      const registered = await page.evaluate((projectPath) => window.siteindex.projects.addExisting(projectPath), fixture.projectDir);
      if (registered.id !== PROJECT_ID) throw mismatch("Packaged Desktop did not register the synthetic project");
      for (const job of ["daily", "weekly"]) {
        noteIpc({ operation: "jobs.run", itemId: 86, job });
        const result = await runJob(page, fixture.projectDir, job);
        if (result.status !== "ok") throw mismatch(`Official baseline ${job} failed: ${result.status}`);
      }
    },
    async verifyBaselineIpc({ page, noteIpc }) {
      noteIpc({ operation: "products.list/inventory.listSkus", itemId: 86, phase: "baseline" });
      await checkBaseline(page);
    },
    async verifyBaselineFile() {
      const files = await inspectFiles();
      baselineFeedSkus = files.skus.filter((item) => item.status === "active").map((item) => item.sku);
      if (!baselineFeedSkus.includes(PRODUCT_DISCOVERY_ROUTES.feedSku)
        || baselineFeedSkus.includes(PRODUCT_DISCOVERY_ROUTES.sitemapOnlySku)) {
        throw mismatch("Official baseline SKU file does not match synthetic Feed and Sitemap");
      }
      baselineTraffic = await loopback.metrics();
      if ((baselineTraffic.byPath[PRODUCT_DISCOVERY_ROUTES.feed] ?? 0) < 1
        || (baselineTraffic.byPath[PRODUCT_DISCOVERY_ROUTES.sitemap] ?? 0) < 1) {
        throw mismatch("Official baseline did not fetch the synthetic Feed and Sitemap");
      }
    },
    async candidateUi({ page, noteIpc }) {
      if (!fixture) throw new Error("Synthetic discovery fixture is missing");
      noteIpc({ operation: "jobs.run", itemId: 86, job: "weekly", only: "pages" });
      const result = await runJob(page, fixture.projectDir, "weekly");
      if (result.status !== "ok" || Number(result.counts?.page_catalog_changed ?? 0) < 1) {
        throw mismatch("Installed candidate weekly Job did not add the sitemap-only product");
      }
      await page.evaluate((id) => { window.location.hash = `#/p/${id}/products`; }, PROJECT_ID);
      await page.getByRole("table").waitFor();
      await page.getByRole("table").getByText(PRODUCT_DISCOVERY_ROUTES.sitemapOnlySku, { exact: true }).first().waitFor();
    },
    async verifyCandidateIpc({ page, noteIpc }) {
      noteIpc({ operation: "products.list/inventory.listSkus", itemId: 86, phase: "candidate" });
      await checkCandidate(page);
    },
    async verifyCandidateFile() {
      const files = await inspectFiles();
      const pageSku = files.skus.find((item) => item.sku === PRODUCT_DISCOVERY_ROUTES.sitemapOnlySku);
      if (pageSku?.source !== "page" || pageSku.price !== 25 || pageSku.status !== "active"
        || files.stock.find((item) => item.sku === pageSku.sku)?.stock_status !== "unknown"
        || !files.products.some((item) => item.skus?.includes(pageSku.sku))
        || !baselineFeedSkus?.every((sku) => files.skus.some((item) => item.sku === sku && item.status === "active"))) {
        throw mismatch("Candidate SKU, inventory or product view files do not show a safe page discovery");
      }
      candidateTraffic = await loopback.metrics();
      if ((candidateTraffic.byPath[PRODUCT_DISCOVERY_ROUTES.sitemap] ?? 0)
          <= (baselineTraffic?.byPath[PRODUCT_DISCOVERY_ROUTES.sitemap] ?? 0)
        || (candidateTraffic.byPath[PRODUCT_DISCOVERY_ROUTES.sitemapOnlyPage] ?? 0)
          <= (baselineTraffic?.byPath[PRODUCT_DISCOVERY_ROUTES.sitemapOnlyPage] ?? 0)) {
        throw mismatch("Candidate did not fetch the synthetic Sitemap and new product page");
      }
    },
    async cleanupSystem() { await loopback?.close(); },
  };
}
