import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PATHS } from "@siteindex/shared";
import { renderEdm } from "../src";

const FIXTURE_PROJECT = path.resolve(process.cwd(), "fixtures/expected/project");
const INPUT_CONTENT = path.resolve(process.cwd(), "fixtures/inputs/edm/2026-10-20-halloween/content.json");
const EXPECTED_CAMPAIGN = path.join(FIXTURE_PROJECT, "edm/2026-10-20-halloween");
const TEMP_DIRS: string[] = [];

async function makeProject(): Promise<{ projectPath: string; campaignDir: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-edm-"));
  TEMP_DIRS.push(root);
  const projectPath = path.join(root, "project");
  await mkdir(path.join(projectPath, PATHS.index, "views"), { recursive: true });
  const campaignDir = path.join(projectPath, "edm/2026-10-20-halloween");
  await mkdir(campaignDir, { recursive: true });
  await cp(path.join(FIXTURE_PROJECT, PATHS.site), path.join(projectPath, PATHS.site));
  await cp(path.join(FIXTURE_PROJECT, PATHS.productsView), path.join(projectPath, PATHS.productsView));
  await cp(INPUT_CONTENT, path.join(campaignDir, "content.json"));
  return { projectPath, campaignDir };
}

afterEach(async () => {
  await Promise.all(TEMP_DIRS.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("EDM renderer", () => {
  it("matches the golden HTML and products JSON byte for byte and skips out-of-stock items", async () => {
    const { projectPath, campaignDir } = await makeProject();
    const result = await renderEdm(projectPath, "edm/2026-10-20-halloween");

    expect(result).toMatchObject({ campaign_id: "2026-10-20-halloween", included: 3 });
    expect(result.warnings).toEqual([
      "feeder-1: 当前 out_of_stock，已跳过（确需保留加 --allow-oos）",
    ]);
    expect(await readFile(path.join(campaignDir, "email.html"), "utf8"))
      .toBe(await readFile(path.join(EXPECTED_CAMPAIGN, "email.html"), "utf8"));
    expect(await readFile(path.join(campaignDir, "products.json"), "utf8"))
      .toBe(await readFile(path.join(EXPECTED_CAMPAIGN, "products.json"), "utf8"));
  }, 15_000);

  it("includes out-of-stock picks when explicitly allowed", async () => {
    const { projectPath, campaignDir } = await makeProject();
    const result = await renderEdm(projectPath, "edm/2026-10-20-halloween", { allowOos: true });
    const products = JSON.parse(await readFile(path.join(campaignDir, "products.json"), "utf8")) as {
      handle: string;
      stock_status: string;
    }[];

    expect(result.included).toBe(4);
    expect(products.find((product) => product.handle === "feeder-1")?.stock_status).toBe("out_of_stock");
    expect(result.warnings).toEqual([]);
  }, 15_000);
});
