import { readFile } from "node:fs/promises";
import path from "node:path";
import { createCategoryScheduleFixture } from "./category-schedule-fixture.mjs";
import { verifyOfflineFonts, verifyPackagedRunJob } from "./release-invariants.mjs";
import { assertSortScopeSnapshots } from "./sort-state-probe.mjs";
import { cleanupProfile, createProfile, exitNormally, launchInstalledApp, waitForObserved } from "./session.mjs";

const PROJECT = "matrix-84";
const OTHER_PROJECT = "matrix-85";
const TABLE = "products.merged";
const PEER_TABLE = "seo.pageRows";
const SAVED = { field: "price", dir: "desc" };
const PEER_SAVED = { field: "url", dir: "asc" };
const PROJECT_SAVED = { field: "product", dir: "asc" };
const DEVICE_SAVED = { field: "price", dir: "asc" };
const LEGACY_COLUMNS = ["sku", "product", "price"];

function mismatch(message) {
  const error = new Error(message);
  error.acceptanceStatus = "assertion_failed";
  return error;
}

async function state(page, projectId) {
  return page.evaluate((id) => window.siteindex.uiState.get(id), projectId);
}

async function productTable(page, projectId) {
  await page.evaluate((id) => { window.location.hash = `#/p/${id}/products`; }, projectId);
  const table = page.getByRole("region", { name: `${TABLE} 数据表` }).getByRole("table");
  await table.waitFor();
  await waitForObserved(async () => (await table.locator('tbody tr:not([aria-hidden="true"])').count()) > 1,
    { label: `${projectId} packaged product rows` });
  return table;
}

async function firstSku(table) {
  return table.locator('tbody tr:not([aria-hidden="true"])').first().locator("td").first().innerText();
}

async function clickSort(page, table, header, projectId, tableId, expected) {
  const column = table.getByRole("columnheader", { name: header });
  await column.getByRole("button").click();
  const expectedAria = expected?.dir === "asc" ? "ascending" : expected?.dir === "desc" ? "descending" : "none";
  await waitForObserved(async () => {
    const saved = (await state(page, projectId)).sorts?.[tableId];
    return JSON.stringify(saved) === JSON.stringify(expected)
      && await column.getAttribute("aria-sort") === expectedAria;
  }, { label: `${projectId}/${tableId} ${expectedAria} sort` });
}

async function readStateFile(profile, projectId) {
  return JSON.parse(await readFile(path.join(profile.root, "sort-cache", projectId, "ui-state.json"), "utf8"));
}

async function inspectSecondDevice(profile, projectDir, firstDeviceId) {
  const secondProfile = await createProfile(profile.root);
  let session;
  try {
    session = await launchInstalledApp({ executable: path.join(profile.layout.installDir, "SiteIndex.exe"),
      profile: secondProfile, port: 9349 });
    const secondDevice = await session.page.evaluate(async ({ root, cache, projectPath }) => {
      await window.siteindex.settings.set({ projects_root: root, cache_dir: cache, close_to_tray: false });
      const settings = await window.siteindex.settings.get();
      await window.siteindex.projects.addExisting(projectPath);
      return settings.device_id;
    }, { root: secondProfile.layout.projectRoot, cache: path.join(secondProfile.root, "sort-cache"), projectPath: projectDir });
    if (!secondDevice || secondDevice === firstDeviceId) throw mismatch("The second packaged profile did not have a distinct device ID");
    const before = await state(session.page, PROJECT);
    if (before.sorts?.[TABLE] !== undefined) throw mismatch("A new device inherited the first device's sort");
    const table = await productTable(session.page, PROJECT);
    await clickSort(session.page, table, "价格", PROJECT, TABLE, DEVICE_SAVED);
    return await state(session.page, PROJECT);
  } finally {
    if (session) await exitNormally(session);
    const cleaned = await cleanupProfile(secondProfile);
    if (cleaned.status !== "passed") throw new Error(`Second packaged profile cleanup failed: ${cleaned.message}`);
  }
}

export function sortStateAdapter() {
  let fixture;
  let otherFixture;
  let firstDeviceId;
  let initialSku;
  let otherDeviceState;
  let fontEvidence;
  let runJobEvidence;
  const verifyScopes = async (page) => assertSortScopeSnapshots({
    primary: await state(page, PROJECT), otherProject: await state(page, OTHER_PROJECT),
    otherDevice: otherDeviceState ?? { sorts: {} }, tableId: TABLE, peerTableId: PEER_TABLE,
    expected: SAVED, peerTableExpected: PEER_SAVED, otherProjectExpected: PROJECT_SAVED,
    otherDeviceExpected: otherDeviceState ? DEVICE_SAVED : null,
  });
  return {
    reportEvidence: () => ({ three_states: ["asc", "desc", "default"],
      scopes: ["table", "project", "device"], legacy_state_preserved: true,
      packaged_fonts: fontEvidence, packaged_run_job: runJobEvidence }),
    async baselineUi({ page, profile, noteIpc }) {
      noteIpc({ operation: "settings.set/projects.addExisting/uiState.set", itemId: 84 });
      const settings = await page.evaluate(async ({ root, cache }) => {
        await window.siteindex.settings.set({ projects_root: root, cache_dir: cache, close_to_tray: false });
        return window.siteindex.settings.get();
      }, { root: profile.layout.projectRoot, cache: path.join(profile.root, "sort-cache") });
      firstDeviceId = settings.device_id;
      fixture = await createCategoryScheduleFixture(profile, 84, firstDeviceId);
      otherFixture = await createCategoryScheduleFixture(profile, 85, firstDeviceId);
      await page.evaluate(async ({ first, second, columns }) => {
        await window.siteindex.projects.addExisting(first);
        await window.siteindex.projects.addExisting(second);
        await window.siteindex.uiState.set("matrix-84", { columns: { "products.merged": columns },
          page_sizes: { "products.merged": 20 } });
      }, { first: fixture.projectDir, second: otherFixture.projectDir, columns: LEGACY_COLUMNS });
      initialSku = await firstSku(await productTable(page, PROJECT));
    },
    async verifyBaselineIpc({ page, noteIpc }) {
      noteIpc({ operation: "uiState.get", itemId: 84, phase: "baseline" });
      const saved = await state(page, PROJECT);
      if (JSON.stringify(saved.columns?.[TABLE]) !== JSON.stringify(LEGACY_COLUMNS)
        || saved.page_sizes?.[TABLE] !== 20 || saved.sorts?.[TABLE] !== undefined) {
        throw mismatch("Official baseline did not retain the old column and page-size state");
      }
    },
    async verifyBaselineFile({ profile }) {
      const saved = await readStateFile(profile, PROJECT);
      if (Object.hasOwn(saved, "sorts") || saved.page_sizes?.[TABLE] !== 20) {
        throw mismatch("Official baseline UI state is not a legacy file without sorts");
      }
    },
    async candidateUi({ page, profile, noteIpc }) {
      noteIpc({ operation: "products.merged UI sort", itemId: 84 });
      fontEvidence = await verifyOfflineFonts(page, path.join(profile.layout.installDir, "SiteIndex.exe"));
      const table = await productTable(page, PROJECT);
      const before = await firstSku(table);
      if (before !== initialSku) throw mismatch("Candidate changed default product order before sorting");
      await clickSort(page, table, "价格", PROJECT, TABLE, DEVICE_SAVED);
      const ascending = await firstSku(table);
      await clickSort(page, table, "价格", PROJECT, TABLE, SAVED);
      await waitForObserved(async () => (await firstSku(table)) !== ascending,
        { label: "descending packaged product order" });
      await clickSort(page, table, "价格", PROJECT, TABLE, null);
      await waitForObserved(async () => (await firstSku(table)) === before,
        { label: "restored default packaged product order" });
      await clickSort(page, table, "价格", PROJECT, TABLE, DEVICE_SAVED);
      await clickSort(page, table, "价格", PROJECT, TABLE, SAVED);
      const otherTable = await productTable(page, OTHER_PROJECT);
      await clickSort(page, otherTable, "产品名称", OTHER_PROJECT, TABLE, PROJECT_SAVED);
      await page.evaluate(() => { window.location.hash = "#/p/matrix-84/seo"; });
      const seo = page.getByRole("region", { name: `${PEER_TABLE} 数据表` }).getByRole("table");
      await seo.waitFor();
      await clickSort(page, seo, "URL", PROJECT, PEER_TABLE, PEER_SAVED);
      await productTable(page, PROJECT);
      if (await page.getByRole("region", { name: `${TABLE} 数据表` }).getByRole("columnheader", { name: "价格" }).getAttribute("aria-sort") !== "descending") {
        throw mismatch("Product sort was lost when switching tables");
      }
    },
    async verifyCandidateIpc({ page, noteIpc }) {
      noteIpc({ operation: "uiState.get", itemId: 84, phase: "candidate" });
      await verifyScopes(page);
      const saved = await state(page, PROJECT);
      if (JSON.stringify(saved.columns?.[TABLE]) !== JSON.stringify(LEGACY_COLUMNS)
        || saved.page_sizes?.[TABLE] !== 20) throw mismatch("Candidate lost the old column or page-size state");
    },
    async verifyCandidateFile({ profile }) {
      const saved = await readStateFile(profile, PROJECT);
      if (JSON.stringify(saved.sorts?.[TABLE]) !== JSON.stringify(SAVED)
        || JSON.stringify(saved.sorts?.[PEER_TABLE]) !== JSON.stringify(PEER_SAVED)
        || JSON.stringify(saved.columns?.[TABLE]) !== JSON.stringify(LEGACY_COLUMNS)) {
        throw mismatch("Candidate did not persist sort and legacy state to local file");
      }
      runJobEvidence = await verifyPackagedRunJob(path.join(profile.layout.installDir, "SiteIndex.exe"),
        profile, otherFixture.projectDir);
      otherDeviceState = await inspectSecondDevice(profile, fixture.projectDir, firstDeviceId);
    },
  };
}
