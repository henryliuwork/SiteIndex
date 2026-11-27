import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { makeW2SyntheticFixture } from "../e-windows-v040-synthetic-fixture.mjs";

const disabledJob = () => ({ enabled: false, days: [], time: "00:00" });
const disabledSchedule = () => ({
  daily: disabledJob(), validate: disabledJob(), weekly: disabledJob(), readme: disabledJob(),
  monthly: { ...disabledJob(), day_of_month: 1 },
  options: { wake_to_run: false, run_if_missed: false, notify_on_failure: false, validate_after_sync: false },
});

/** Reuses the existing synthetic Woo fixture without a real site or local customer data. */
export async function createCategoryScheduleFixture(profile, id, deviceId) {
  if (!Number.isInteger(id) || !((id >= 46 && id <= 60) || id === 85) || !deviceId) {
    throw new Error("Invalid synthetic matrix fixture");
  }
  const projectId = `matrix-${id}`;
  const projectDir = path.join(profile.layout.projectRoot, projectId);
  const index = path.join(projectDir, "index");
  const fixture = makeW2SyntheticFixture("https://fixture.example.test");
  const config = fixture.config;
  config.categories = id === 46 ? { mode: "feed", url_pattern: "/shop/{slug}", manual: [] }
    : id === 47 ? { mode: "url_rule", url_pattern: "/shop/{slug}", manual: [] }
      : { mode: "manual", url_pattern: "/shop/{slug}", manual: [{ name: "Base category", slug: "base-category",
        url: "https://fixture.example.test/collections/base-category",
        match: [{ type: "url_contains", value: "base-category" }] }] };
  config.schedule = disabledSchedule();
  const files = [
    ["catalog/skus.jsonl", fixture.skus], ["catalog/product_details.jsonl", fixture.productDetails],
    ["inventory/latest.jsonl", fixture.latest], ["views/sku_stock.jsonl", fixture.skuStock],
    ["views/products.jsonl", fixture.products], ["seo/pages.jsonl", fixture.seoPages],
    ["seo/issues.jsonl", fixture.seoIssues], ["seo/links.jsonl", fixture.seoLinks],
    ["content/blog_index.jsonl", fixture.blogs], ["content/keywords.jsonl", []],
    ["ledgers/outreach.jsonl", fixture.outreach], ["ledgers/edm_campaigns.jsonl", []],
    ["logs/runs.jsonl", []],
  ];
  await mkdir(index, { recursive: true });
  await writeFile(path.join(index, "site.json"), `${JSON.stringify(config, null, 2)}\n`);
  await writeFile(path.join(index, ".runner.json"), `${JSON.stringify({ device_id: deviceId,
    device_name: "Synthetic matrix runner", claimed_at: "2026-11-24T00:00:00.000Z" })}\n`);
  for (const [name, rows] of files) {
    const target = path.join(index, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, rows.length ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n` : "");
  }
  await writeFile(path.join(index, "catalog", "categories.json"), `${JSON.stringify(fixture.categories, null, 2)}\n`);
  for (const month of ["2026-10", "2026-11"]) {
    const target = path.join(index, "inventory", "events", `${month}.jsonl`);
    const rows = fixture.events.filter((event) => event.date.startsWith(month));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  }
  const daily = fixture.dailySummaryRows.map((row) =>
    [row.date, row.category, row.total, row.in_stock, row.out_of_stock, row.preorder, row.unknown].join(","));
  await writeFile(path.join(index, "inventory", "daily_summary.csv"),
    `date,category,total,in_stock,out_of_stock,preorder,unknown\n${daily.join("\n")}\n`);
  await writeFile(path.join(index, "ledgers", "sku_media.csv"),
    "sku,image_role,image_url,alt_text,source,width,height,updated_at\n");
  await writeFile(path.join(index, "ledgers", "sku_tags.csv"),
    "sku,tags,priority,exclude_edm,email_blurb,season,note,updated_at\n");
  return { projectId, projectDir, siteFile: path.join(index, "site.json") };
}
