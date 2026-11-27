import { readFile } from "node:fs/promises";
import path from "node:path";
import { createCategoryScheduleFixture } from "./category-schedule-fixture.mjs";
import { probeSearchInput } from "./search-input-probe.mjs";
import { waitForObserved } from "./session.mjs";

export const SEARCH_CASES = Object.freeze([
  { route: "products", label: "搜索产品与 SKU", empty: "没有匹配的产品或 SKU",
    loading: "正在加载产品与库存数据" },
  { route: "edm", label: "搜索 SKU 图片", empty: "没有 SKU 图片记录",
    loading: "正在加载 SKU 图片" },
]);
const SNAPSHOT_FILES = ["catalog/skus.jsonl", "views/products.jsonl", "ledgers/sku_media.csv"];

function mismatch(message) {
  const error = new Error(message);
  error.acceptanceStatus = "assertion_failed";
  return error;
}

async function snapshotFiles(projectDir) {
  return Promise.all(SNAPSHOT_FILES.map((name) => readFile(path.join(projectDir, "index", name))));
}

async function verifyIpc(page, projectId) {
  const data = await page.evaluate(async (id) => {
    const [products, images, matchingProducts, matchingImages] = await Promise.all([
      window.siteindex.products.list(id, { page: 1, pageSize: 20 }),
      window.siteindex.edm.listImages(id, { page: 1, pageSize: 20 }),
      window.siteindex.products.list(id, { page: 1, pageSize: 20, search: "abc" }),
      window.siteindex.edm.listImages(id, { page: 1, pageSize: 20, search: "abc" }),
    ]);
    return { productTotal: products.total, imageTotal: images.total,
      matchingProducts: matchingProducts.total, matchingImages: matchingImages.total };
  }, projectId);
  if (data.productTotal < 1 || data.imageTotal < 1
    || data.matchingProducts !== 0 || data.matchingImages !== 0) {
    throw mismatch("Synthetic search IPC data does not have the expected nonempty and empty results");
  }
  return data;
}

async function navigate(page, projectId, testCase) {
  await page.evaluate(({ id, route }) => { window.location.hash = `#/p/${id}/${route}`; },
    { id: projectId, route: testCase.route });
  const searchbox = page.getByRole("searchbox", { name: testCase.label });
  const table = page.getByRole("table");
  await searchbox.waitFor();
  await table.waitFor();
  await waitForObserved(async () => (await table.getByRole("row").count()) > 2,
    { label: `${testCase.route} initial synthetic rows` });
}

export function searchInputAdapter() {
  const projectId = "matrix-85";
  let fixture;
  let baselineFiles;
  const checkFiles = async () => {
    if (!fixture || !baselineFiles) throw new Error("Synthetic search fixture snapshot is missing");
    const actual = await snapshotFiles(fixture.projectDir);
    if (actual.some((file, index) => !file.equals(baselineFiles[index]))) {
      throw mismatch("Search or candidate upgrade rewrote synthetic project data");
    }
  };
  return {
    reportEvidence: () => ({ checked_pages: SEARCH_CASES.map((entry) => entry.route),
      query: "abc", query_timing: "packaged UI and IPC" }),
    async baselineUi({ page, profile, noteIpc }) {
      noteIpc({ operation: "settings.set", itemId: 85, fields: ["projects_root", "close_to_tray"] });
      const settings = await page.evaluate(async (root) => {
        await window.siteindex.settings.set({ projects_root: root, close_to_tray: false });
        return window.siteindex.settings.get();
      }, profile.layout.projectRoot);
      fixture = await createCategoryScheduleFixture(profile, 85, settings.device_id);
      await navigate(page, projectId, SEARCH_CASES[0]);
    },
    async verifyBaselineIpc({ page, noteIpc }) {
      noteIpc({ operation: "products.list/edm.listImages", itemId: 85, search: "abc" });
      await verifyIpc(page, projectId);
    },
    async verifyBaselineFile() {
      if (!fixture) throw new Error("Synthetic search fixture is missing");
      baselineFiles = await snapshotFiles(fixture.projectDir);
    },
    async candidateUi({ page, noteIpc }) {
      await checkFiles();
      for (const testCase of SEARCH_CASES) {
        await navigate(page, projectId, testCase);
        noteIpc({ operation: `${testCase.route}.search`, itemId: 85, query: "abc" });
        const table = page.getByRole("table");
        await probeSearchInput({ page, label: testCase.label,
          isQueryComplete: async () => (await table.innerText()).includes(testCase.empty),
          hasWholeTableLoading: async () => {
            if (await table.count() !== 1) return true;
            const statuses = await page.getByRole("status").allTextContents();
            return statuses.some((status) => status.includes(testCase.loading));
          } });
      }
    },
    async verifyCandidateIpc({ page, noteIpc }) {
      noteIpc({ operation: "products.list/edm.listImages", itemId: 85, search: "abc" });
      await verifyIpc(page, projectId);
    },
    async verifyCandidateFile() { await checkFiles(); },
  };
}
