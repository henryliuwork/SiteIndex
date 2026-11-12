import { cp, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PATHS, type CreateProjectInput } from "@siteindex/shared";
import { assertProjectStorageLocal, createCoreService, inspectProjectStorageLocation, renderEdm, upsertLedger, withLock, writeRunner } from "../src";

const fixtureProject = path.resolve(process.cwd(), "fixtures/expected/project");
const policyFixture = path.resolve(process.cwd(), "fixtures/e-v041-loopback/project-storage-policy-cases.json");
const tempRoots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-project-storage-"));
  tempRoots.push(root);
  return root;
}

function createService(projectPath: string, overrides: { onJobStarted?: () => void } = {}) {
  return createCoreService({
    resolveProject: () => projectPath,
    deviceId: "storage-test-device",
    cacheDir: path.join(path.dirname(projectPath), "cache"),
    ...overrides,
  });
}

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("known cloud project storage policy", () => {
  it("matches only paths inside a configured provider root using synthetic policy cases", async () => {
    const root = await tempRoot();
    const syncRoot = path.join(root, "Synthetic OneDrive");
    const fixture = JSON.parse(await readFile(policyFixture, "utf8")) as {
      cases: Array<{ id: string; relation: string; expected: string; provider?: string }>;
    };
    vi.stubEnv("OneDrive", syncRoot);

    for (const scenario of fixture.cases) {
      const projectPath = scenario.relation === "inside-root"
        ? path.join(syncRoot, "project")
        : scenario.relation === "prefix-sibling"
          ? path.join(root, "Synthetic OneDrive Archive", "project")
          : path.join(root, "unconfigured-third-party", "project");
      if (scenario.relation === "unconfigured") vi.stubEnv("OneDrive", "");
      const assessment = await inspectProjectStorageLocation(projectPath);
      expect(assessment.status, scenario.id).toBe(scenario.expected);
      if (scenario.provider) expect(assessment.provider, scenario.id).toBe(scenario.provider);
    }
  });

  it("rejects create and workspace create before creating target directories or starting detection", async () => {
    const root = await tempRoot();
    const syncRoot = path.join(root, "sync");
    vi.stubEnv("OneDrive", syncRoot);
    const fetcher = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetcher);
    const targetPath = path.join(syncRoot, "new-project");
    const api = createService(path.join(root, "unused"));
    const input: CreateProjectInput = {
      url: "https://synthetic.example.test",
      feed_urls: [],
      sku_field: "id",
      category_depth: 1,
      missing_as: "out_of_stock",
      brand: { name: "Synthetic Store" },
      markets: [],
      projects_root: syncRoot,
      folder_name: "new-project",
      workspace_folders: [],
    };

    await expect(api.projects.create(input)).rejects.toMatchObject({ code: "PROJECT_CLOUD_SYNC_UNSUPPORTED" });
    await expect(api.workspace.create({
      targetDir: targetPath,
      domain: "synthetic.example.test",
      brand: { name: "Synthetic Store" },
      platform: "other",
      esp_presets: [],
    })).rejects.toMatchObject({ code: "PROJECT_CLOUD_SYNC_UNSUPPORTED" });
    await expect(api.projects.createWorkspaceOnly({
      url: "https://synthetic.example.test",
      projects_root: syncRoot,
      folder_name: "new-project",
      brand: { name: "Synthetic Store" },
      markets: [],
      workspace: { enabled: true, platform: "other", esp_presets: [] },
    })).rejects.toMatchObject({ code: "PROJECT_CLOUD_SYNC_UNSUPPORTED" });

    expect(fetcher).not.toHaveBeenCalled();
    await expect(readdir(syncRoot)).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("keeps registered known-cloud projects readable and flags the summary", async () => {
    const root = await tempRoot();
    const syncRoot = path.join(root, "sync");
    const projectPath = path.join(syncRoot, "legacy-project");
    vi.stubEnv("OneDrive", syncRoot);
    await mkdir(syncRoot, { recursive: true });
    await cp(fixtureProject, projectPath, { recursive: true });
    const siteBefore = await readFile(path.join(projectPath, PATHS.site));

    const detail = await createService(projectPath).projects.get("legacy-project");

    expect(detail.summary.storage_location).toBe("known_cloud_sync");
    expect(detail.summary.warnings).toContain("此项目位于已知云同步目录，当前仅支持只读查看。请手动复制到本机目录后重新添加。");
    expect(await readFile(path.join(projectPath, PATHS.site))).toEqual(siteBefore);
  });

  it("does not label an unrecognized project as verified local storage", async () => {
    const root = await tempRoot();
    const projectPath = path.join(root, "unconfigured-third-party", "legacy-project");
    vi.stubEnv("OneDrive", "");
    await mkdir(path.dirname(projectPath), { recursive: true });
    await cp(fixtureProject, projectPath, { recursive: true });

    const detail = await createService(projectPath).projects.get("legacy-project");

    expect(detail.summary).not.toHaveProperty("storage_location");
    expect(detail.summary.warnings).not.toContain("此项目位于已知云同步目录，当前仅支持只读查看。请手动复制到本机目录后重新添加。");
  });

  it("rejects Jobs before notifications, locks, run logs, or error logs are written", async () => {
    const root = await tempRoot();
    const syncRoot = path.join(root, "sync");
    const projectPath = path.join(syncRoot, "legacy-project");
    vi.stubEnv("OneDrive", syncRoot);
    await mkdir(syncRoot, { recursive: true });
    await cp(fixtureProject, projectPath, { recursive: true });
    const runsPath = path.join(projectPath, PATHS.runs);
    const runsBefore = await readFile(runsPath);
    const errorLogDir = path.join(projectPath, PATHS.jobLogsDir);
    await expect(readdir(errorLogDir)).rejects.toMatchObject({ code: "ENOENT" });
    const started = vi.fn();
    const report = vi.fn();
    const api = createService(projectPath, { onJobStarted: started });

    await expect(api.runJob({ projectPath, job: "media", trigger: "manual", skus: ["SYNTH001"] }, report))
      .rejects.toMatchObject({ code: "PROJECT_CLOUD_SYNC_UNSUPPORTED" });

    expect(started).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
    expect(await readFile(runsPath)).toEqual(runsBefore);
    await expect(readdir(errorLogDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(projectPath, PATHS.lock))).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("blocks direct runner, lock, ledger, and EDM writes on known cloud paths", async () => {
    const root = await tempRoot();
    const syncRoot = path.join(root, "sync");
    const projectPath = path.join(syncRoot, "legacy-project");
    vi.stubEnv("OneDrive", syncRoot);
    await mkdir(syncRoot, { recursive: true });
    await cp(fixtureProject, projectPath, { recursive: true });
    const sitePath = path.join(projectPath, PATHS.site);
    const readmePath = path.join(projectPath, PATHS.readme);
    const siteBefore = await readFile(sitePath);
    await expect(readFile(readmePath)).rejects.toMatchObject({ code: "ENOENT" });
    const api = createService(projectPath);

    await expect(assertProjectStorageLocal(projectPath)).rejects.toMatchObject({ code: "PROJECT_CLOUD_SYNC_UNSUPPORTED" });
    await expect(withLock(projectPath, async () => undefined)).rejects.toMatchObject({ code: "PROJECT_CLOUD_SYNC_UNSUPPORTED" });
    await expect(writeRunner(projectPath, {
      device_id: "test-device", device_name: "Test", claimed_at: "2026-11-12T00:00:00.000Z",
    })).rejects.toMatchObject({ code: "PROJECT_CLOUD_SYNC_UNSUPPORTED" });
    await expect(upsertLedger(projectPath, "keywords", [])).rejects.toMatchObject({ code: "PROJECT_CLOUD_SYNC_UNSUPPORTED" });
    await expect(renderEdm(projectPath, "edm/synthetic-campaign")).rejects.toMatchObject({ code: "PROJECT_CLOUD_SYNC_UNSUPPORTED" });
    await expect(api.projects.updateConfig("legacy-project", { brand: { name: "Changed Synthetic Store" } }))
      .rejects.toMatchObject({ code: "PROJECT_CLOUD_SYNC_UNSUPPORTED" });
    const readme = await api.readme.get("legacy-project");
    await expect(api.readme.saveUserBlocks("legacy-project", readme.user_blocks))
      .rejects.toMatchObject({ code: "PROJECT_CLOUD_SYNC_UNSUPPORTED" });
    const schedule = await api.schedule.get("legacy-project");
    await expect(api.schedule.save("legacy-project", schedule.config))
      .rejects.toMatchObject({ code: "PROJECT_CLOUD_SYNC_UNSUPPORTED" });
    await expect(api.workspace.importCheck("legacy-project", { apply: true }))
      .rejects.toMatchObject({ code: "PROJECT_CLOUD_SYNC_UNSUPPORTED" });
    expect(await readFile(sitePath)).toEqual(siteBefore);
    await expect(readFile(readmePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(projectPath, PATHS.lock))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
