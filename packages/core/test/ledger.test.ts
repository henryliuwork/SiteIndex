import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PATHS } from "@siteindex/shared";
import { deleteLedger, readCsv, readJsonl, upsertLedger } from "../src";

const FIXTURE_PROJECT = path.resolve(process.cwd(), "fixtures/expected/project");
const TEMP_DIRS: string[] = [];

async function makeProject(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-ledger-"));
  TEMP_DIRS.push(root);
  const projectPath = path.join(root, "project");
  await cp(FIXTURE_PROJECT, projectPath, { recursive: true });
  return projectPath;
}

afterEach(async () => {
  await Promise.all(TEMP_DIRS.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("core ledger mutations", () => {
  it("normalizes keyword and domain keys, merges only supplied fields and fills site-local dates", async () => {
    const projectPath = await makeProject();
    const now = new Date("2026-10-22T01:00:00.000Z");
    const keywords = await upsertLedger(projectPath, "keywords", [
      { keyword: "  CARDINAL FEEDER ", note: "updated" },
      {
        keyword: " New Bird Feeder ", target_url: null, role: "secondary", intent: "commercial",
        cluster: "backyard birds", status: "planned",
      },
    ], { now });
    expect(keywords).toEqual({ added: 1, updated: 1, deleted: 0, total: 3 });
    const keywordRows = await readJsonl(path.join(projectPath, PATHS.keywords));
    expect(keywordRows.find((row) => row.keyword === "cardinal feeder")).toMatchObject({
      note: "updated", role: "secondary", updated_at: "2026-10-21",
    });
    expect(keywordRows.find((row) => row.keyword === "new bird feeder")).toMatchObject({ updated_at: "2026-10-21" });

    const outreach = await upsertLedger(projectPath, "outreach", [
      { domain: " WWW.BackyardBirdingBlog.com ", status: "contacted" },
      { domain: "www.newbirdingblog.com", status: "pushed" },
    ], { now });
    expect(outreach).toMatchObject({ added: 1, updated: 1 });
    const outreachRows = await readJsonl(path.join(projectPath, PATHS.outreach));
    expect(outreachRows.find((row) => row.domain === "backyardbirdingblog.com")).toMatchObject({
      status: "contacted", added_at: "2026-10-21",
    });
    expect(outreachRows.find((row) => row.domain === "newbirdingblog.com")).toMatchObject({ added_at: "2026-10-21" });

    await expect(deleteLedger(projectPath, "outreach", ["newbirdingblog.com", "missing.example"], { now }))
      .resolves.toEqual({ added: 0, updated: 0, deleted: 1, total: outreachRows.length - 1 });

    const campaign = await upsertLedger(projectPath, "edm_campaigns", [{
      campaign_id: "2026-10-23-test-campaign", date: "2026-10-23", theme: "Test campaign",
      status: "draft", handles: ["feeder-0"],
    }], { now });
    expect(campaign.added).toBe(1);
    expect(await deleteLedger(projectPath, "edm_campaigns", ["2026-10-23-test-campaign"], { now }))
      .toMatchObject({ deleted: 1, total: 1 });
  }, 15_000);

  it("writes CSV ledgers in canonical columns, joins list values and supports composite keys", async () => {
    const projectPath = await makeProject();
    const now = new Date("2026-10-22T01:00:00.000Z");
    const result = await upsertLedger(projectPath, "sku_tags", [
      { sku: "KYBF002", tags: ["holiday", "fall"], email_blurb: "Seasonal pick" },
      { sku: "NEW-SKU", tags: ["new", "spring"], priority: 2 },
    ], { now });
    expect(result).toMatchObject({ added: 1, updated: 1 });
    const filePath = path.join(projectPath, PATHS.skuTags);
    const csv = await readFile(filePath, "utf8");
    expect(csv.split("\n", 1)[0]).toBe("sku,tags,priority,exclude_edm,email_blurb,season,note,updated_at");
    expect((await readCsv(filePath)).find((row) => row.sku === "KYBF002")).toMatchObject({
      tags: "holiday;fall", email_blurb: "Seasonal pick", updated_at: "2026-10-21",
    });

    const media = await upsertLedger(projectPath, "sku_media", [
      { sku: "NEW-SKU", image_role: "main", image_url: "https://cdn.example/new.jpg", source: "cdn", alt_text: "Product" },
    ], { now });
    expect(media.added).toBe(1);
    await expect(deleteLedger(projectPath, "sku_media", [["NEW-SKU", "main"]], { now }))
      .resolves.toMatchObject({ deleted: 1, total: expect.any(Number) });
  }, 15_000);

  it("requires complete primary keys and rejects malformed composite delete keys", async () => {
    const projectPath = await makeProject();
    await expect(upsertLedger(projectPath, "keywords", [{ keyword: "  " }]))
      .rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("主键") });
    await expect(deleteLedger(projectPath, "sku_media", ["KYBF000-G"]))
      .rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("删除键") });
  }, 15_000);
});
