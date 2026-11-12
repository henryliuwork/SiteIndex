import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readJsonl, writeJsonl } from "@siteindex/core";
import { pathsFor, type CreateProjectInput, type DetectResult, type ProjectLayout } from "@siteindex/shared";
import { createFakeGraphqlService, type FakeGraphqlService } from "../../../fixtures/e-v041-loopback/fake-services.mjs";
import { createFakeSiteService, type FakeSiteService } from "../../../fixtures/e-v041-loopback/fake-site-service.mjs";
import { createConfig, createProjectFiles } from "../../core/src/projects/create";
import { createWorkspaceFiles } from "../../core/src/workspace/create";

interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface CliChild {
  child: ChildProcess;
  stdout: string;
  stderr: string;
  closed: Promise<ChildExit>;
}

const childSource = String.raw`
import path from "node:path";
import { createCoreService } from "./src/index.ts";
import { main } from "../cli/src/index.ts";

const projectPath = process.env.SITEINDEX_TEST_PROJECT_PATH;
const fixtureDate = process.env.SITEINDEX_TEST_DATE;
const barrierTarget = process.env.SITEINDEX_TEST_DAILY_BARRIER_TARGET;
const cacheDir = process.env.SITEINDEX_TEST_CACHE_DIR;
if (!projectPath || !fixtureDate || !cacheDir) throw new Error("Missing isolated daily fixture parameters");

const service = createCoreService({
  resolveProject: (id) => String(id),
  deviceId: "process-recovery-fixture",
  deviceName: "Process recovery fixture",
  cacheDir,
  ...(barrierTarget ? {
    testOnlyBeforeDailyTargetReplace: async (relativeTarget) => {
      if (relativeTarget !== barrierTarget) return;
      process.stdout.write("DAILY_TXN_BARRIER_READY\n");
      await new Promise((resolve) => process.stdin.once("data", resolve));
    },
  } : {}),
});

const code = await main(["run", projectPath, "daily", "--date", fixtureDate, "--json"], {
  out: (value) => process.stdout.write(value + "\n"),
  err: (value) => process.stderr.write(value + "\n"),
  cwd: path.dirname(projectPath),
  env: process.env,
  settings: {
    projects_root: path.dirname(projectPath),
    cache_dir: cacheDir,
    device_id: "process-recovery-fixture",
    device_name: "Process recovery fixture",
  },
  service,
});
process.exitCode = code;
`;

const DATE = "2026-10-22";
const TARGETS = (layout: ProjectLayout) => {
  const paths = pathsFor(layout);
  return [
    `${paths.eventsDir}/2026-10.jsonl`,
    paths.inventoryLatest,
    paths.skus,
    paths.dailySummary,
  ];
};

let tempRoot = "";
const liveChildren: CliChild[] = [];
const siteServices: FakeSiteService[] = [];
const graphqlServices: FakeGraphqlService[] = [];

function startCliChild(projectPath: string, stateRoot: string, barrierTarget?: string): CliChild {
  const cacheDir = path.join(stateRoot, "cache");
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    APPDATA: path.join(stateRoot, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(stateRoot, "AppData", "Local"),
    USERPROFILE: stateRoot,
    HOME: stateRoot,
    XDG_CONFIG_HOME: path.join(stateRoot, "config"),
    XDG_STATE_HOME: path.join(stateRoot, "state"),
    SITEINDEX_TEST_PROJECT_PATH: projectPath,
    SITEINDEX_TEST_DATE: DATE,
    SITEINDEX_TEST_CACHE_DIR: cacheDir,
    ...(barrierTarget ? { SITEINDEX_TEST_DAILY_BARRIER_TARGET: barrierTarget } : {}),
  };
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childSource], {
    cwd: path.resolve("packages/core"),
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const run: CliChild = { child, stdout: "", stderr: "", closed: Promise.resolve({ code: null, signal: null }) };
  child.stdout?.on("data", (chunk: Buffer | string) => { run.stdout += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer | string) => { run.stderr += chunk.toString(); });
  run.closed = new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  liveChildren.push(run);
  return run;
}

function waitForStdout(run: CliChild, marker: string, timeoutMs = 30_000): Promise<void> {
  if (run.stdout.includes(marker)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      run.child.stdout?.off("data", onData);
      run.child.off("close", onClose);
      if (error) reject(error);
      else resolve();
    };
    const onData = () => {
      if (run.stdout.includes(marker)) finish();
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(new Error(`CLI child exited before barrier (${String(code)} / ${String(signal)}): ${run.stderr}`));
    };
    const timer = setTimeout(() => {
      run.child.kill("SIGKILL");
      finish(new Error(`Timed out waiting for daily transaction barrier: ${run.stderr}`));
    }, timeoutMs);
    run.child.stdout?.on("data", onData);
    run.child.once("close", onClose);
  });
}

async function waitForChildExit(run: CliChild, timeoutMs = 30_000): Promise<ChildExit> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      run.closed,
      new Promise<ChildExit>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`CLI child did not exit: ${run.stderr}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function writeSyntheticProject(
  projectPath: string,
  layout: ProjectLayout,
  siteService: FakeSiteService,
  graphqlService: FakeGraphqlService,
): Promise<void> {
  const paths = pathsFor(layout);
  const input: CreateProjectInput = {
    url: "https://shop.example.test",
    feed_urls: [siteService.feedUrl],
    sku_field: "id",
    category_depth: 1,
    missing_as: "out_of_stock",
    brand: { name: "Synthetic Shop" },
    markets: [],
    projects_root: path.dirname(projectPath),
    folder_name: path.basename(projectPath),
    workspace_folders: [],
  };
  const detected: DetectResult = {
    input: input.url,
    final_url: siteService.origin,
    redirect_status: null,
    robots: { found: false, disallow_count: 0, sitemaps: [] },
    sitemaps: [],
    total_urls: 0,
    platform: "magento",
    platform_evidence: "synthetic fixture",
    frontend: null,
    locale: "en-US",
    currency: "USD",
    feed_candidates: [],
  };
  const baseConfig = createConfig(input, detected);
  const siteConfig = {
    ...baseConfig,
    domain: "shop.example.test",
    crawl: {
      ...baseConfig.crawl,
      max_removed_ratio: 1,
      rate_limit_ms: 200,
      stock_verify: { enabled: true, graphql_url: graphqlService.endpoint, max_per_run: 10 },
    },
  };
  if (layout === "legacy") {
    await createProjectFiles(input, detected, path.resolve("templates/project"));
  } else {
    await createWorkspaceFiles({
      targetDir: projectPath,
      domain: "shop.example.test",
      brand: input.brand,
      platform: "magento2",
      markets: [],
      esp_presets: [],
    }, { templateDir: path.resolve("templates/project"), siteConfig, baseUrl: siteService.origin });
  }
  const sitePath = path.join(projectPath, paths.site);
  await writeFile(sitePath, `${JSON.stringify(siteConfig, null, 2)}\n`, "utf8");
  await writeJsonl(path.join(projectPath, paths.skus), [
    ...["DEMO-PRESENT", "DEMO-ABSENT"].map((sku) => ({
      sku,
      product_id: `PRODUCT-${sku}`,
      handle: sku.toLowerCase(),
      title: `Synthetic ${sku}`,
      variant_title: null,
      url: siteService.productUrl(sku),
      category: "synthetic",
      categories: ["synthetic"],
      category_source: "feed",
      price: 10,
      compare_at_price: null,
      currency: "USD",
      image_url: null,
      status: "active",
      first_seen: "2026-10-20",
      last_seen: "2026-10-21",
      updated_at: "2026-10-21",
    })),
  ], "sku");
  await writeJsonl(path.join(projectPath, paths.inventoryLatest), [
    { sku: "DEMO-PRESENT", stock_status: "in_stock", qty: 3, since: "2026-10-20", checked_at: "2026-10-21T12:00:00Z" },
    { sku: "DEMO-ABSENT", stock_status: "out_of_stock", qty: null, since: "2026-10-20", checked_at: "2026-10-21T12:00:00Z" },
  ], "inventory_latest");
}

async function pathExists(filePath: string): Promise<boolean> {
  try { await access(filePath); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

afterEach(async () => {
  for (const run of liveChildren.splice(0)) {
    if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill("SIGKILL");
    await waitForChildExit(run).catch(() => undefined);
  }
  await Promise.all(siteServices.splice(0).map((service) => service.close()));
  await Promise.all(graphqlServices.splice(0).map((service) => service.close()));
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  tempRoot = "";
});

describe("daily stock verification process recovery through CLI", () => {
  it("recovers a killed partial transaction in a fresh CLI process for both layouts", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "siteindex-daily-process-recovery-"));
    const stateRoot = path.join(tempRoot, "isolated-user-state");
    await mkdir(stateRoot, { recursive: true });
    const siteService = await createFakeSiteService({
      feedRows: [{ sku: "DEMO-PRESENT", availability: "in stock" }],
      defaultProductResponse: { status: 200, body: "<main>Product page with no stock text.</main>" },
    });
    siteServices.push(siteService);
    const graphqlService = await createFakeGraphqlService({
      responsesBySku: {
        "DEMO-ABSENT": { body: { data: { products: { items: [{ sku: "DEMO-ABSENT", stock_status: "IN_STOCK" }] } } } },
      },
    });
    graphqlServices.push(graphqlService);

    for (const [layout, projectName] of [["legacy", "project-legacy"], ["workspace", "project-workspace"]] as const) {
      const projectPath = path.join(tempRoot, projectName);
      const paths = pathsFor(layout);
      await writeSyntheticProject(projectPath, layout, siteService, graphqlService);
      const initialLatest = await readJsonl(path.join(projectPath, paths.inventoryLatest));
      const barrierTarget = paths.inventoryLatest;
      const interruptedRun = startCliChild(projectPath, stateRoot, barrierTarget);

      await waitForStdout(interruptedRun, "DAILY_TXN_BARRIER_READY");
      const manifestPath = path.join(projectPath, paths.jobLogsDir, "daily-output-transaction.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        files: { target: string; backup: string | null; staged: string; before_hash: string | null; after_hash: string }[];
      };
      expect(manifest.files.map((file) => file.target)).toEqual(TARGETS(layout));
      expect(manifest.files.every((file) => file.staged.startsWith(`${paths.jobLogsDir}/daily-output-transaction-backups/`))).toBe(true);
      expect(manifest.files.every((file) => file.backup === null || file.backup.startsWith(`${paths.jobLogsDir}/daily-output-transaction-backups/`))).toBe(true);
      await Promise.all(manifest.files.map(async (file) => {
        await readFile(path.join(projectPath, file.staged));
        if (file.backup) await readFile(path.join(projectPath, file.backup));
      }));
      expect(await readJsonl(path.join(projectPath, manifest.files[0]!.target))).toEqual(expect.arrayContaining([
        expect.objectContaining({ sku: "DEMO-ABSENT", type: "feed_anomaly" }),
      ]));
      expect(Object.fromEntries((await readJsonl(path.join(projectPath, paths.inventoryLatest))).map((row) => [String(row.sku), row])))
        .toEqual(Object.fromEntries(initialLatest.map((row) => [String(row.sku), row])));
      const cursorPath = path.join(projectPath, paths.jobLogsDir, "stock-verification-cursor.json");
      expect(JSON.parse(await readFile(cursorPath, "utf8"))).toMatchObject({ pending_skus: ["DEMO-ABSENT"] });

      expect(interruptedRun.child.kill("SIGKILL")).toBe(true);
      const killed = await waitForChildExit(interruptedRun);
      expect(killed.code === 0).toBe(false);

      const resumedRun = startCliChild(projectPath, stateRoot);
      const resumedExit = await waitForChildExit(resumedRun);
      expect(resumedExit).toEqual({ code: 0, signal: null });
      const outputLines = resumedRun.stdout.trim().split(/\r?\n/u).filter(Boolean);
      const outcome = JSON.parse(outputLines.at(-1) ?? "{}") as {
        ok?: boolean;
        data?: { job?: string; status?: string; counts?: Record<string, number>; errors?: string[] };
      };
      expect(outcome.data?.errors).toBeUndefined();
      expect(outcome).toMatchObject({
        ok: true,
        data: { job: "daily", status: "ok", counts: { stock_verified: 1, feed_anomaly: 1 } },
      });

      const latest = await readJsonl(path.join(projectPath, paths.inventoryLatest));
      expect(latest).toHaveLength(2);
      expect(latest.find((row) => row.sku === "DEMO-ABSENT")).toMatchObject({ stock_status: "in_stock" });
      const catalog = await readJsonl(path.join(projectPath, paths.skus));
      expect(catalog).toHaveLength(2);
      expect(catalog.find((row) => row.sku === "DEMO-ABSENT")).toMatchObject({ status: "active" });
      const eventPath = path.join(projectPath, paths.eventsDir, "2026-10.jsonl");
      const events = await readJsonl(eventPath);
      expect(events.filter((row) => row.sku === "DEMO-ABSENT" && row.type === "feed_anomaly")).toHaveLength(1);
      expect(events.filter((row) => row.sku === "DEMO-ABSENT" && row.type === "stock_change")).toHaveLength(1);
      expect(events.some((row) => row.sku === "DEMO-ABSENT" && row.type === "removed_sku")).toBe(false);
      expect(JSON.parse(await readFile(cursorPath, "utf8"))).toMatchObject({ last_sku: "DEMO-ABSENT", pending_skus: [] });

      const backupPath = path.join(projectPath, paths.jobLogsDir, "daily-output-transaction-backups");
      expect(await readdir(backupPath).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error))).toEqual([]);
      expect(await pathExists(manifestPath)).toBe(false);
      expect(await pathExists(path.join(projectPath, paths.lock))).toBe(false);

      const projectFiles = (await readdir(projectPath, { recursive: true })).map(String);
      expect(projectFiles.some((entry) => entry.includes("daily-output-transaction") && entry !== paths.jobLogsDir)).toBe(false);
    }

    expect(siteService.boundHost).toBe("127.0.0.1");
    expect(graphqlService.boundHost).toBe("127.0.0.1");
    expect((await readdir(tempRoot)).sort()).toEqual(["isolated-user-state", "project-legacy", "project-workspace"]);
  }, 120_000);
});
