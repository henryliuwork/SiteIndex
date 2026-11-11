import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { CSV_HEADERS, isValidMediaSkuRecoveryPartition, PATHS, type InventoryLatest, type SiteConfig, type SkuRecord } from "@siteindex/shared";
import { copyFile, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createFakeCredentialCanary,
  createFakeWordPressService,
  scanCredentialCanary,
  type FakeWordPressService,
} from "../../../fixtures/e-v041-loopback/fake-services.mjs";
import { createCoreService } from "../src/service";
import { readCsv, writeCsv } from "../src/io/csv";
import { readJsonl, writeJsonl } from "../src/io/jsonl";

const FIXTURE_PROJECT = path.resolve(process.cwd(), "fixtures/expected/project");
const WEBP_BYTES = Buffer.from("UklGRi4AAABXRUJQVlA4TCEAAAAvAUAAEB8w/wKCIv9HCwFB0XXLBXwU1LRtwOI36YjofxwA", "base64");
const TEMP_DIRS: string[] = [];
const SOURCE_SERVERS: Server[] = [];
const WORDPRESS_SERVERS: FakeWordPressService[] = [];

async function startImageServer(): Promise<{ origin: string; close: () => Promise<void> }> {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { "content-type": "image/webp", "content-length": WEBP_BYTES.length });
    response.end(WEBP_BYTES);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  SOURCE_SERVERS.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Synthetic image server did not bind to a loopback port.");
  const origin = "http://127.0.0.1:" + (address as AddressInfo).port;
  return {
    origin,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function makeProject(options: {
  wordpressOrigin: string;
  sourceImageUrl: string;
  grouping?: SiteConfig["sku_grouping"];
  skuIds?: string[];
  mediaLedgerFixturePath?: string;
}): Promise<{ root: string; projectPath: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-media-job-"));
  TEMP_DIRS.push(root);
  const projectPath = path.join(root, "project");
  await cp(FIXTURE_PROJECT, projectPath, { recursive: true });
  const sitePath = path.join(projectPath, PATHS.site);
  const config = JSON.parse(await readFile(sitePath, "utf8")) as SiteConfig;
  config.domain = "fixture.example.test";
  config.base_url = options.wordpressOrigin;
  config.crawl.feed_url = [];
  config.crawl.rate_limit_ms = 0;
  config.edm = { ...config.edm, image_host: { type: "wordpress" } };
  if (options.grouping) config.sku_grouping = options.grouping;
  await writeFile(sitePath, JSON.stringify(config, null, 2) + "\n", "utf8");

  const date = "2026-11-11";
  const skuIds = options.skuIds ?? ["DEMO001A", "DEMO002"];
  const skus: SkuRecord[] = skuIds.map((sku, index) => ({
    sku,
    product_id: "synthetic-product-" + index,
    handle: "synthetic-product-" + index,
    title: "Synthetic product " + sku,
    variant_title: null,
    url: "https://products.example.test/" + sku.toLowerCase(),
    category: "Synthetic",
    categories: ["Synthetic"],
    category_source: "feed",
    price: 12.5,
    compare_at_price: null,
    currency: "USD",
    image_url: sku === "DEMO002" ? "https://cdn.example.test/demo002.png" : options.sourceImageUrl,
    additional_images: [],
    gtin: null,
    mpn: null,
    brand: "Demo",
    status: "active",
    first_seen: date,
    last_seen: date,
    updated_at: date,
  }));
  const latest: InventoryLatest[] = skus.map((row) => ({
    sku: row.sku,
    stock_status: row.sku === "DEMO002" ? "out_of_stock" : "in_stock",
    qty: row.sku === "DEMO002" ? 0 : 4,
    since: date,
    checked_at: date + "T12:00:00+00:00",
  }));
  await writeJsonl(path.join(projectPath, PATHS.skus), skus.map((row) => ({ ...row })), { primaryKey: ["sku"] });
  await writeJsonl(path.join(projectPath, PATHS.inventoryLatest), latest.map((row) => ({ ...row })), { primaryKey: ["sku"] });
  await writeCsv(path.join(projectPath, PATHS.skuMedia), [], CSV_HEADERS.skuMedia, ["sku", "image_role"]);
  if (options.mediaLedgerFixturePath) await copyFile(options.mediaLedgerFixturePath, path.join(projectPath, PATHS.skuMedia));
  return { root, projectPath };
}

function service(projectPath: string, credential?: { username: string; applicationPassword: string }) {
  return createCoreService({
    resolveProject: () => projectPath,
    deviceId: "media-test-device",
    cacheDir: path.join(path.dirname(projectPath), "cache"),
    ...(credential ? { wordpressCredential: credential } : {}),
    testOnlyAllowLoopbackHttp: true,
  });
}

async function makeWordPress(options: Parameters<typeof createFakeWordPressService>[0]) {
  const instance = await createFakeWordPressService(options);
  WORDPRESS_SERVERS.push(instance);
  return instance;
}

interface MediaAcceptanceCase {
  id: string;
  request_skus: string[];
  fake_wordpress?: { media_post_statuses?: number[]; disconnect_after_persist?: number };
  core_acceptance_oracle: {
    media_batch_state: "complete" | "interrupted" | "outcome_unknown";
    media_error_code?: "WP_AUTH_FAILED" | "WP_FORBIDDEN";
    media_results: { sku: string; status: string }[];
    media_unknown_skus: string[];
    media_not_started_skus: string[];
    job_status?: "ok" | "partial" | "failed";
  };
}

async function mediaAcceptanceCases(): Promise<MediaAcceptanceCase[]> {
  const fixturePath = path.resolve(process.cwd(), "fixtures/e-v041-loopback/job-export-cases.json");
  const parsed = JSON.parse(await readFile(fixturePath, "utf8")) as { media_job_cases: MediaAcceptanceCase[] };
  return parsed.media_job_cases.filter((item) => item.id.startsWith("MEDIA-"));
}

afterEach(async () => {
  await Promise.all(SOURCE_SERVERS.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  })));
  await Promise.all(WORDPRESS_SERVERS.splice(0).map((server) => server.close()));
  await Promise.all(TEMP_DIRS.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("media Core Job", () => {
  it("converts and uploads a selected parent representative, reuses it on retry, and records direct PNG URLs", async () => {
    const credentials = createFakeCredentialCanary();
    const wordpress = await makeWordPress({ credentials });
    const imageServer = await startImageServer();
    const { projectPath } = await makeProject({
      wordpressOrigin: wordpress.origin,
      sourceImageUrl: imageServer.origin + "/synthetic.webp",
      grouping: { enabled: true, rule: { type: "suffix", value: "A" } },
    });
    const api = service(projectPath, credentials);
    const progress: unknown[] = [];

    const first = await api.runJob({
      projectPath, job: "media", trigger: "manual", date: "2026-11-11", skus: ["DEMO001", "DEMO001"],
    }, (event) => { progress.push(event); });
    expect(first.status).toBe("ok");
    expect(first.media_requested_skus).toEqual(["DEMO001"]);
    expect(first.media_batch_state).toBe("complete");
    expect(first.media_results).toMatchObject([{ sku: "DEMO001", status: "uploaded", image_url: wordpress.origin + "/wp-content/uploads/demo001a-main.jpg" }]);
    expect(first.media_unknown_skus).toEqual([]);
    expect(first.media_not_started_skus).toEqual([]);

    await writeCsv(path.join(projectPath, PATHS.skuMedia), [], CSV_HEADERS.skuMedia, ["sku", "image_role"]);
    const reused = await api.runJob({
      projectPath, job: "media", trigger: "manual", date: "2026-11-11", skus: ["DEMO001"],
    }, () => undefined);
    expect(reused.media_results).toMatchObject([{ sku: "DEMO001", status: "reused" }]);

    const direct = await api.runJob({
      projectPath, job: "media", trigger: "manual", date: "2026-11-11", skus: ["DEMO002"],
    }, () => undefined);
    expect(direct.media_results).toMatchObject([{ sku: "DEMO002", status: "recorded", image_url: "https://cdn.example.test/demo002.png" }]);
    expect(await readCsv(path.join(projectPath, PATHS.skuMedia))).toEqual(expect.arrayContaining([
      expect.objectContaining({ sku: "DEMO001A", source: "wordpress", media_id: "7000", source_hash: expect.any(String) }),
      expect.objectContaining({ sku: "DEMO002", source: "cdn", media_id: null }),
    ]));
    expect(wordpress.snapshot().mediaCount).toBe(1);
    expect(wordpress.snapshot().routeCounts["POST /wp-json/wp/v2/media"]).toBe(1);
    expect(wordpress.snapshot().routeCounts["POST /wp-json/wp/v2/media/:id"]).toBeGreaterThanOrEqual(2);

    const canary = scanCredentialCanary({
      first, reused, direct,
      logs: await readJsonl(path.join(projectPath, PATHS.runs)),
      ledger: await readFile(path.join(projectPath, PATHS.skuMedia), "utf8"),
      checkpoint: await readFile(path.join(projectPath, PATHS.jobLogsDir, `${first.runId}.media.json`), "utf8"),
      progress,
    }, credentials);
    expect(canary.passed).toBe(true);
    expect(first.runId).not.toBe(reused.runId);
  }, 30_000);

  it("stops after a definite authentication failure and leaves remaining SKUs not started", async () => {
    const credentials = createFakeCredentialCanary();
    const wordpress = await makeWordPress({ credentials, mediaGetStatus: 401 });
    const imageServer = await startImageServer();
    const { projectPath } = await makeProject({ wordpressOrigin: wordpress.origin, sourceImageUrl: imageServer.origin + "/synthetic.webp" });
    const result = await service(projectPath, credentials).runJob({
      projectPath, job: "media", trigger: "manual", date: "2026-11-11", skus: ["DEMO001A", "DEMO002"],
    }, () => undefined);

    expect(result.status).toBe("failed");
    expect(result.media_error_code).toBe("WP_AUTH_FAILED");
    expect(result.media_results).toMatchObject([{ sku: "DEMO001A", status: "failed", reason: "WordPress 应用密码认证失败。" }]);
    expect(result.media_not_started_skus).toEqual(["DEMO002"]);
    expect(result.media_unknown_skus).toEqual([]);
    expect(scanCredentialCanary(result, credentials).passed).toBe(true);
  }, 30_000);

  it("marks a persisted upload with a lost response as outcome unknown", async () => {
    const credentials = createFakeCredentialCanary();
    const wordpress = await makeWordPress({ credentials, disconnectAfterPersist: 1 });
    const imageServer = await startImageServer();
    const { projectPath } = await makeProject({ wordpressOrigin: wordpress.origin, sourceImageUrl: imageServer.origin + "/synthetic.webp" });
    const result = await service(projectPath, credentials).runJob({
      projectPath, job: "media", trigger: "manual", date: "2026-11-11", skus: ["DEMO001A"],
    }, () => undefined);

    expect(result.status).toBe("partial");
    expect(result.media_batch_state).toBe("outcome_unknown");
    expect(result.media_results).toEqual([]);
    expect(result.media_unknown_skus).toEqual(["DEMO001A"]);
    expect(result.media_not_started_skus).toEqual([]);
    expect(wordpress.snapshot().mediaCount).toBe(1);
    expect(isValidMediaSkuRecoveryPartition(JSON.parse(await readFile(
      path.join(projectPath, PATHS.jobLogsDir, `${result.runId}.media.json`), "utf8",
    )))).toBe(true);
    const logged = await readJsonl(path.join(projectPath, PATHS.runs));
    expect(logged.at(-1)).toMatchObject({
      job: "media",
      media_batch_state: "outcome_unknown",
      media_unknown_skus: ["DEMO001A"],
    });
  }, 30_000);

  it("records a direct PNG URL without WordPress credentials", async () => {
    const { projectPath } = await makeProject({
      wordpressOrigin: "https://wordpress.example.test",
      sourceImageUrl: "https://cdn.example.test/demo001a.png",
    });
    const result = await service(projectPath).runJob({
      projectPath, job: "media", trigger: "manual", date: "2026-11-11", skus: ["DEMO001A"],
    }, () => undefined);

    expect(result.status).toBe("ok");
    expect(result.media_batch_state).toBe("complete");
    expect(result.media_results).toEqual([{
      sku: "DEMO001A", status: "recorded", image_url: "https://cdn.example.test/demo001a.png",
    }]);
    expect(result.media_not_started_skus).toEqual([]);
    expect(await readCsv(path.join(projectPath, PATHS.skuMedia))).toContainEqual(
      expect.objectContaining({ sku: "DEMO001A", image_url: "https://cdn.example.test/demo001a.png", source: "cdn" }),
    );
    const checkpoint = JSON.parse(await readFile(path.join(projectPath, PATHS.jobLogsDir, `${result.runId}.media.json`), "utf8")) as {
      run_id: string; checkpoint_state: string; media_batch_state: string;
    };
    expect(checkpoint).toMatchObject({ run_id: result.runId, checkpoint_state: "finished", media_batch_state: "complete" });
  });

  it("rejects private-network image URLs before making a request", async () => {
    const credentials = createFakeCredentialCanary();
    const wordpress = await makeWordPress({ credentials });
    const { projectPath } = await makeProject({
      wordpressOrigin: wordpress.origin,
      sourceImageUrl: "https://127.0.0.1/synthetic.webp",
    });
    const result = await service(projectPath, credentials).runJob({
      projectPath, job: "media", trigger: "manual", date: "2026-11-11", skus: ["DEMO001A"],
    }, () => undefined);

    expect(result.status).toBe("failed");
    expect(result.media_results).toMatchObject([{
      sku: "DEMO001A", status: "failed", reason: "商品图片地址不符合安全要求。",
    }]);
    expect(wordpress.snapshot().totalRequests).toBe(0);
  });

  it("matches the #438 recovery and batch-stop fixtures through Core", async () => {
    const cases = await mediaAcceptanceCases();
    const batchCases = cases.filter((item) => [
      "MEDIA-401-after-confirmed-item",
      "MEDIA-403-after-confirmed-item",
      "MEDIA-ordinary-partial-then-continue",
      "MEDIA-save-then-disconnect",
    ].includes(item.id));

    for (const fixtureCase of batchCases) {
      const credentials = createFakeCredentialCanary();
      const wordpress = await makeWordPress({
        credentials,
        mediaPostStatuses: fixtureCase.fake_wordpress?.media_post_statuses,
        disconnectAfterPersist: fixtureCase.fake_wordpress?.disconnect_after_persist,
      });
      const imageServer = await startImageServer();
      const { projectPath } = await makeProject({
        wordpressOrigin: wordpress.origin,
        sourceImageUrl: imageServer.origin + "/synthetic.webp",
        skuIds: fixtureCase.request_skus,
      });
      const result = await service(projectPath, credentials).runJob({
        projectPath, job: "media", trigger: "manual", date: "2026-11-11", skus: fixtureCase.request_skus,
      }, () => undefined);
      const expected = fixtureCase.core_acceptance_oracle;

      expect(isValidMediaSkuRecoveryPartition(result)).toBe(true);
      expect(result.media_batch_state).toBe(expected.media_batch_state);
      expect(result.media_error_code).toBe(expected.media_error_code);
      expect(result.media_results?.map(({ sku, status }) => ({ sku, status }))).toEqual(expected.media_results);
      expect(result.media_unknown_skus).toEqual(expected.media_unknown_skus);
      expect(result.media_not_started_skus).toEqual(expected.media_not_started_skus);
      if (expected.job_status) expect(result.status).toBe(expected.job_status);

      if (fixtureCase.id === "MEDIA-save-then-disconnect") {
        const retry = await service(projectPath, credentials).runJob({
          projectPath, job: "media", trigger: "manual", date: "2026-11-11", skus: [fixtureCase.request_skus[0]!],
        }, () => undefined);
        expect(retry.media_results).toMatchObject([{ sku: fixtureCase.request_skus[0], status: "reused" }]);
        expect(wordpress.snapshot().mediaCount).toBe(1);
        expect(wordpress.snapshot().routeCounts["POST /wp-json/wp/v2/media"]).toBe(1);
      }
    }
  }, 60_000);

  it("uses #438 same-day fixture for deduplication and preserves legacy media rows on first write", async () => {
    const cases = await mediaAcceptanceCases();
    const sameDay = cases.find((item) => item.id === "MEDIA-same-day-rerun-and-deduplicate-request");
    expect(sameDay).toBeDefined();
    const fixtureRoot = path.resolve(process.cwd(), "fixtures/e-v041-loopback");
    const sameDayPath = path.join(fixtureRoot, "media-export/same-day-sku-media.csv");
    const { projectPath: sameDayProject } = await makeProject({
      wordpressOrigin: "https://wordpress.example.test",
      sourceImageUrl: "https://cdn.example.test/demo.png",
      skuIds: sameDay!.request_skus,
      mediaLedgerFixturePath: sameDayPath,
    });
    const duplicateRequest = await service(sameDayProject).runJob({
      projectPath: sameDayProject, job: "media", trigger: "manual", date: "2026-11-11", skus: sameDay!.request_skus,
    }, () => undefined);
    expect(duplicateRequest.media_requested_skus).toEqual(["SYN-M041", "SYN-M042"]);
    expect(duplicateRequest.media_results?.map(({ sku, status }) => ({ sku, status }))).toEqual([
      { sku: "SYN-M041", status: "skipped_has_url" },
      { sku: "SYN-M042", status: "skipped_has_url" },
    ]);

    const legacyPath = path.join(fixtureRoot, "media-export/legacy-sku-media.csv");
    const { projectPath: legacyProject } = await makeProject({
      wordpressOrigin: "https://wordpress.example.test",
      sourceImageUrl: "https://cdn.example.test/new-main.png",
      skuIds: ["SYN-B001", "SYN-C001", "DEMO001A"],
      mediaLedgerFixturePath: legacyPath,
    });
    const before = await readFile(path.join(legacyProject, PATHS.skuMedia));
    const legacySkip = await service(legacyProject).runJob({
      projectPath: legacyProject, job: "media", trigger: "manual", date: "2026-11-11", skus: ["SYN-B001"],
    }, () => undefined);
    expect(legacySkip.media_results).toMatchObject([{ sku: "SYN-B001", status: "skipped_has_url" }]);
    expect(await readFile(path.join(legacyProject, PATHS.skuMedia))).toEqual(before);

    const firstWrite = await service(legacyProject).runJob({
      projectPath: legacyProject, job: "media", trigger: "manual", date: "2026-11-11", skus: ["DEMO001A"],
    }, () => undefined);
    expect(firstWrite.media_results).toMatchObject([{ sku: "DEMO001A", status: "recorded" }]);
    const migrated = await readFile(path.join(legacyProject, PATHS.skuMedia), "utf8");
    expect(migrated.split(/\r?\n/u)[0]).toBe(CSV_HEADERS.skuMediaV2.join(","));
    expect(migrated).toContain("SYN-B001,main,https://synthetic-cdn.invalid/images/syn-b001.jpg,Synthetic B main,mailchimp,800,600,2026-11-11,,");
    expect(migrated).toContain("SYN-C001,lifestyle,https://synthetic-cdn.invalid/images/syn-c001-life.png,Synthetic C lifestyle,cdn,640,480,2026-11-11,,");
  });
});
