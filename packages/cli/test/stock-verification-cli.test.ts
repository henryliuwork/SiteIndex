import { afterEach, describe, expect, it, vi } from "vitest";
import { createCoreService, readJsonl, writeJsonl } from "@siteindex/core";
import { pathsFor, type ProjectLayout } from "@siteindex/shared";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createFakeGraphqlService, type FakeGraphqlService } from "../../../fixtures/e-v041-loopback/fake-services.mjs";
import { createFakeSiteService, type FakeSiteService } from "../../../fixtures/e-v041-loopback/fake-site-service.mjs";
import { main } from "../src";

const writeFault = vi.hoisted(() => ({ target: null as string | null }));
vi.mock("../../core/src/io/atomic-write", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/src/io/atomic-write")>();
  return {
    ...actual,
    atomicWrite: async (filePath: string, data: string | Uint8Array, beforeReplace?: () => Promise<void>) => {
      if (writeFault.target && path.resolve(filePath) === writeFault.target) {
        writeFault.target = null;
        throw new Error("Injected CLI stock verification output interruption");
      }
      return actual.atomicWrite(filePath, data, beforeReplace);
    },
  };
});

const FIXTURE_DATE = "2026-10-22";
let tempRoot = "";
const siteServices: FakeSiteService[] = [];
const graphqlServices: FakeGraphqlService[] = [];

afterEach(async () => {
  writeFault.target = null;
  await Promise.all(siteServices.splice(0).map((service) => service.close()));
  await Promise.all(graphqlServices.splice(0).map((service) => service.close()));
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  tempRoot = "";
});

describe("CLI daily stock verification product path", () => {
  it("runs through CLI and Core in both layouts, preserves partial results, and recovers an interrupted commit", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "siteindex-cli-stock-verify-"));
    const siteService = await createFakeSiteService({
      feedRows: [{ sku: "DEMO-PRESENT", availability: "in stock" }],
      productResponsesBySku: {
        "DEMO-PERMISSION-FALLBACK": { body: "<main>Availability: in stock</main>" },
        "DEMO-UNAVAILABLE": { body: "<main>Availability is not stated.</main>" },
      },
    });
    siteServices.push(siteService);
    const graphqlService = await createFakeGraphqlService({
      responsesBySku: {
        "DEMO-PERMISSION-FALLBACK": { httpStatus: 403, body: { errors: [{ message: "Synthetic permission denied." }] } },
        "DEMO-UNAVAILABLE": { httpStatus: 503, body: { errors: [{ message: "Synthetic service unavailable." }] } },
      },
    });
    graphqlServices.push(graphqlService);

    for (const layout of ["legacy", "workspace"] as const satisfies readonly ProjectLayout[]) {
      const projectPath = path.join(tempRoot, layout);
      const paths = pathsFor(layout);
      const sitePath = path.join(projectPath, paths.site);
      await mkdir(path.dirname(sitePath), { recursive: true });
      await writeFile(sitePath, `${JSON.stringify({
        schema_version: "1.1",
        domain: "shop.example.test",
        base_url: siteService.origin,
        platform: "magento",
        currency: "USD",
        locale: "en-US",
        timezone: "UTC",
        markets: [],
        brand: { name: "Synthetic Shop" },
        sitemaps: [],
        crawl: {
          adapter: "gmc_feed",
          feed_url: siteService.feedUrl,
          sku_field: "id",
          category_depth: 1,
          missing_as: "out_of_stock",
          max_removed_ratio: 1,
          rate_limit_ms: 0,
          stock_verify: { enabled: true, graphql_url: graphqlService.endpoint, max_per_run: 10 },
          stock_rules: { in_stock: ["in stock"], out_of_stock: ["sold out", "out of stock"], preorder: ["preorder"] },
        },
      }, null, 2)}\n`, "utf8");

      await writeJsonl(path.join(projectPath, paths.skus), [
        { sku: "DEMO-PRESENT", url: siteService.productUrl("DEMO-PRESENT"), status: "active", first_seen: "2026-10-20", last_seen: "2026-10-21", updated_at: "2026-10-21" },
        { sku: "DEMO-PERMISSION-FALLBACK", url: siteService.productUrl("DEMO-PERMISSION-FALLBACK"), status: "active", first_seen: "2026-10-20", last_seen: "2026-10-21", updated_at: "2026-10-21" },
        { sku: "DEMO-UNAVAILABLE", url: siteService.productUrl("DEMO-UNAVAILABLE"), status: "active", first_seen: "2026-10-20", last_seen: "2026-10-21", updated_at: "2026-10-21" },
      ], "sku");
      const initialInventory = ["DEMO-PRESENT", "DEMO-PERMISSION-FALLBACK", "DEMO-UNAVAILABLE"].map((sku) => ({
        sku,
        stock_status: "out_of_stock",
        qty: null,
        since: "2026-10-20",
        checked_at: "2026-10-21T12:00:00Z",
      }));
      await writeJsonl(path.join(projectPath, paths.inventoryLatest), initialInventory, "inventory_latest");

      const service = createCoreService({
        resolveProject: (id) => String(id),
        deviceId: "cli-stock-fixture",
        deviceName: "CLI stock fixture",
        cacheDir: path.join(tempRoot, "cache", layout),
      });
      const stdout: string[] = [];
      const stderr: string[] = [];
      const io = {
        out: (value: string) => stdout.push(value),
        err: (value: string) => stderr.push(value),
        cwd: tempRoot,
        settings: { projects_root: tempRoot, cache_dir: path.join(tempRoot, "cli-cache", layout) },
        service,
      };
      const args = ["run", projectPath, "daily", "--date", FIXTURE_DATE, "--json"];

      writeFault.target = path.resolve(projectPath, paths.inventoryLatest);
      const interruptedExit = await main(args, io);
      const interrupted = JSON.parse(stdout.at(-1) ?? "{}") as { ok?: boolean; data?: { status?: string }; error?: { code?: string } };
      expect(interruptedExit).not.toBe(0);
      expect(interrupted.ok).toBe(false);
      expect(interrupted.error?.code).toBe("JOB_FAILED");
      const beforeRetry = await readJsonl(path.join(projectPath, paths.inventoryLatest));
      expect(Object.fromEntries(beforeRetry.map((row) => [String(row.sku), row])))
        .toEqual(Object.fromEntries(initialInventory.map((row) => [row.sku, row])));
      const cursorPath = path.join(projectPath, paths.jobLogsDir, "stock-verification-cursor.json");
      expect(JSON.parse(await readFile(cursorPath, "utf8"))).toMatchObject({ pending_skus: ["DEMO-PERMISSION-FALLBACK", "DEMO-UNAVAILABLE"] });

      stdout.length = 0;
      stderr.length = 0;
      const retryExit = await main(args, io);
      const retried = JSON.parse(stdout.at(-1) ?? "{}") as {
        ok?: boolean;
        data?: { status?: string; counts?: Record<string, number>; errors?: string[] };
      };
      expect(retryExit).toBe(0);
      expect(retried.ok).toBe(true);
      expect(retried.data).toMatchObject({
        status: "partial",
        counts: { stock_verified: 2, stock_verify_unavailable: 1, feed_anomaly: 1 },
      });
      expect(retried.data?.errors?.join(" ")).toContain("原库存状态已保留");

      const latest = new Map((await readJsonl(path.join(projectPath, paths.inventoryLatest))).map((row) => [String(row.sku), row]));
      expect(latest.get("DEMO-PERMISSION-FALLBACK")).toMatchObject({ stock_status: "in_stock" });
      expect(latest.get("DEMO-UNAVAILABLE")).toMatchObject({ stock_status: "out_of_stock", checked_at: "2026-10-21T12:00:00Z" });
      const events = await readJsonl(path.join(projectPath, paths.eventsDir, "2026-10.jsonl"));
      expect(events.filter((row) => row.sku === "DEMO-PERMISSION-FALLBACK" && row.type === "feed_anomaly")).toHaveLength(1);
      expect(JSON.parse(await readFile(cursorPath, "utf8"))).toMatchObject({ pending_skus: [] });
    }

    expect(siteService.boundHost).toBe("127.0.0.1");
    expect(graphqlService.boundHost).toBe("127.0.0.1");
    expect(siteService.snapshot().requestHeadersRecorded).toBe(false);
    expect(graphqlService.snapshot().requestBodiesRecorded).toBe(false);
  }, 60_000);
});
