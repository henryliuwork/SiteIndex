import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}

async function readJsonl(relativePath) {
  const text = await readFile(path.join(root, relativePath), "utf8");
  return text.trimEnd().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function assertUnique(values, label) {
  assert.equal(new Set(values).size, values.length, `${label} contains duplicate keys`);
}

test("SEO result fixtures cover complete, partial, and unavailable provenance states", async () => {
  const expected = await readJson("expected.json");
  const fixture = await readJson("scenario-results.json");
  assert.equal(fixture.fixture_only, true);

  for (const scenario of expected.seo_scenarios) {
    const result = fixture.results[scenario.result_id];
    assert.ok(result, `${scenario.id} must have a result`);
    assert.deepEqual(result.metadata.missing_fields, scenario.expected_missing_fields);
    assert.deepEqual(result.metadata.anomalies.map(({ code }) => code), scenario.expected_anomaly_codes);
    assert.equal(result.metadata.quality, scenario.expected_quality);
    assert.equal(result.metadata.collected_at, scenario.expected_collected_at);
    if (result.metadata.collected_at !== null) assert.ok(Number.isFinite(Date.parse(result.metadata.collected_at)));
    assert.ok(Array.isArray(result.metadata.sources));
    for (const source of result.metadata.sources) {
      assert.match(source.kind, /^[a-z][a-z0-9_]*$/u);
      assert.ok(!JSON.stringify(source).match(/https?:|password|token|username|response_body/iu));
    }
    if (scenario.expected_quality === "unreliable") assert.equal(result.data, null);
    else assert.ok(result.data && typeof result.data === "object");
  }
});

test("legacy and workspace projects expose the same logical SEO and product-stock inputs", async () => {
  const expected = await readJson("expected.json");
  const logicalTables = ["seo_pages", "seo_issues", "catalog_skus", "inventory_latest", "products_view", "sku_stock_view"];

  for (const table of logicalTables) {
    const legacy = await readJsonl(path.join(expected.layouts.legacy.project_root, expected.layouts.legacy[table]));
    const workspace = await readJsonl(path.join(expected.layouts.workspace.project_root, expected.layouts.workspace[table]));
    assert.deepEqual(workspace, legacy, `${table} must match across layouts`);
  }

  const legacySite = await readJson(path.join(expected.layouts.legacy.project_root, "index/site.json"));
  const workspaceSite = await readJson(path.join(expected.layouts.workspace.project_root, "_site-index/site.json"));
  const pages = await readJsonl(path.join(expected.layouts.legacy.project_root, expected.layouts.legacy.seo_pages));
  const issues = await readJsonl(path.join(expected.layouts.legacy.project_root, expected.layouts.legacy.seo_issues));
  assert.equal(legacySite.domain, "synthetic-shop.test");
  assert.equal(workspaceSite.domain, legacySite.domain);
  assert.deepEqual(workspaceSite.sku_grouping, legacySite.sku_grouping);
  assert.deepEqual(pages.map(({ status_code }) => status_code).sort(), [200, 503]);
  assert.deepEqual(issues.map(({ rule, severity, status }) => ({ rule, severity, status })), [
    { rule: "http_5xx", severity: "high", status: "open" },
  ]);
});

test("products and inventory inputs preserve unique real SKUs and parent-child coverage", async () => {
  const expected = await readJson("expected.json");
  const layout = expected.layouts.legacy;
  const skus = await readJsonl(path.join(layout.project_root, layout.catalog_skus));
  const stock = await readJsonl(path.join(layout.project_root, layout.sku_stock_view));
  const products = await readJsonl(path.join(layout.project_root, layout.products_view));
  const inventory = await readJsonl(path.join(layout.project_root, layout.inventory_latest));

  const skuIds = skus.map(({ sku }) => sku);
  const stockIds = stock.map(({ sku }) => sku);
  const latestIds = inventory.map(({ sku }) => sku);
  const productSkuIds = products.flatMap(({ skus: productSkus }) => productSkus);
  for (const [values, label] of [[skuIds, "catalog"], [stockIds, "stock view"], [latestIds, "inventory latest"], [productSkuIds, "products view"]]) {
    assertUnique(values, label);
    assert.deepEqual([...values].sort(), expected.products_inventory.sku_ids);
  }

  const rule = new RegExp(expected.products_inventory.grouping_rule.value, "u");
  const groups = new Map();
  for (const sku of skuIds) {
    const parent = rule.exec(sku)?.[1];
    if (!parent) continue;
    const children = groups.get(parent) ?? [];
    children.push(sku);
    groups.set(parent, children);
  }
  const actualGroups = [...groups].map(([parent_sku, children]) => ({ parent_sku, children: children.sort() }));
  assert.deepEqual(actualGroups, expected.products_inventory.groups);

  const groupedChildren = new Set(expected.products_inventory.groups.flatMap(({ children }) => children));
  const parentByChild = new Map(expected.products_inventory.groups.flatMap(({ parent_sku, children }) => children.map((sku) => [sku, parent_sku])));
  const unmatched = skuIds.filter((sku) => !groupedChildren.has(sku)).sort();
  assert.deepEqual(unmatched, expected.products_inventory.unmatched_skus);
  for (const row of stock) assert.equal(row.parent_sku ?? null, parentByChild.get(row.sku) ?? null, `${row.sku} parent relation`);
  assert.ok(!skuIds.includes("SYN-AX"), "synthetic parent must not be persisted as a real SKU");
  assert.ok(!stockIds.includes("SYN-AX"), "synthetic parent must not be persisted as a stock entity");

  const parentOnlyInventorySkus = [...expected.products_inventory.groups.map(({ parent_sku }) => parent_sku), ...unmatched].sort();
  assert.deepEqual(parentOnlyInventorySkus, expected.products_inventory.parent_only_inventory_skus);
  const parentOnlyProductHandles = [
    ...expected.products_inventory.groups.map(({ children }) => {
      const matching = products.find(({ skus: productSkus }) => children.some((sku) => productSkus.includes(sku)));
      assert.ok(matching, `product view must preserve group ${children.join(", ")}`);
      assert.deepEqual([...matching.skus].sort(), children);
      return matching.handle;
    }),
    ...products.filter(({ skus: productSkus }) => productSkus.some((sku) => unmatched.includes(sku))).map(({ handle }) => handle),
  ].sort();
  assert.deepEqual(parentOnlyProductHandles, expected.products_inventory.parent_only_product_handles);
  assert.deepEqual(expected.products_inventory.legacy_routes, ["/p/:id/products", "/p/:id/inventory"]);
  assert.ok(!products.some(({ product_id }) => product_id === "SYN-AX"), "synthetic parent must not be persisted as a product row");
  assert.ok(expected.products_inventory.retained_features.includes("products.exportCsv"));
  assert.ok(expected.products_inventory.retained_features.includes("inventory.exportCsv"));

  const representedByParentOnly = [
    ...expected.products_inventory.groups.flatMap(({ children }) => children),
    ...expected.products_inventory.unmatched_skus,
  ].sort();
  assert.deepEqual(representedByParentOnly, expected.products_inventory.sku_ids);
  assert.equal(expected.products_inventory.persisted_synthetic_parent_rows, 0);
  assert.equal(expected.products_inventory.summary_sku_count, skuIds.length);
});
