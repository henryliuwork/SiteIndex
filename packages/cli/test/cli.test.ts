import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CoreService } from "@siteindex/core";
import { DEFAULT_WORKSPACE_FOLDERS, EXIT, PATHS, type CliJsonOutput, type CreateProjectInput, type SiteConfig, type ScheduleConfig, type SkillInfo, type ValidationReport } from "@siteindex/shared";
import { main, type CliIO } from "../src";

const projectFixture = fileURLToPath(new URL("../../../fixtures/expected/project/", import.meta.url));
const edmContentFixture = fileURLToPath(new URL("../../../fixtures/inputs/edm/2026-10-20-halloween/content.json", import.meta.url));
const expectedEmail = fileURLToPath(new URL("../../../fixtures/expected/project/edm/2026-10-20-halloween/email.html", import.meta.url));
const expectedProducts = fileURLToPath(new URL("../../../fixtures/expected/project/edm/2026-10-20-halloween/products.json", import.meta.url));
const skillsFixture = fileURLToPath(new URL("../../../skills/", import.meta.url));
const fixtureConfig = JSON.parse(readFileSync(path.join(projectFixture, PATHS.site), "utf8")) as SiteConfig;

const testSchedule: ScheduleConfig = {
  daily: { enabled: true, days: [1, 2, 3, 4, 5, 6, 7], time: "02:00" },
  validate: { enabled: true, days: [1, 2, 3, 4, 5, 6, 7], time: "02:30" },
  weekly: { enabled: true, days: [1], time: "03:00" },
  readme: { enabled: true, days: [7], time: "05:00" },
  monthly: { enabled: true, day_of_month: 1, time: "04:00" },
  options: { wake_to_run: true, run_if_missed: true, notify_on_failure: true, validate_after_sync: true },
};

let tempRoot = "";
let projectPath = "";
let fixtureReady = false;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "siteindex-cli-"));
  projectPath = path.join(tempRoot, "kingsyard");
  fixtureReady = false;
}, 30000);

afterEach(async () => {
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
}, 30000);

async function copyFixtureProject(): Promise<void> {
  if (fixtureReady) return;
  await cp(projectFixture, projectPath, { recursive: true });
  await cp(edmContentFixture, path.join(projectPath, "edm", "2026-10-20-halloween", "content.json"));
  fixtureReady = true;
}

function collect(service?: CoreService, options: Partial<CliIO> = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CliIO = {
    out: (value) => stdout.push(value),
    err: (value) => stderr.push(value),
    cwd: tempRoot,
    settings: { projects_root: tempRoot, cache_dir: path.join(tempRoot, "cache"), device_id: "cli-test", device_name: "CLI Test" },
    ...(service ? { service } : {}),
    ...options,
  };
  return { io, stdout, stderr };
}

function parseEnvelope<T = unknown>(text: string): CliJsonOutput<T> {
  return JSON.parse(text) as CliJsonOutput<T>;
}

function mockService() {
  const jobResult = { runId: "2026-10-26-weekly", job: "weekly", status: "ok", exitCode: EXIT.OK, summary: "每周同步完成。" };
  const report: ValidationReport = { checked_at: "2026-10-26T00:00:00Z", trigger: "manual", summary: { total: 1, ok: 1, error: 0, missing: 0, conflict_copy: 0 }, files: [] };
  const queryResult = { rows: [{ handle: "sample" }], total: 1 };
  const service = {
    projects: {
      detect: vi.fn(async (url: string) => ({ input: url, platform: "other" })),
      create: vi.fn(async (_input: unknown) => ({ id: "kingsyard", runId: "2026-10-26-daily" })),
      get: vi.fn(async () => ({ config: { ...fixtureConfig, schedule: testSchedule } })),
      inspectFeed: vi.fn(async () => ({ items: 16, usable_skus: 16 })),
    },
    runJob: vi.fn(async () => jobResult),
    files: {
      validate: vi.fn(async () => report),
      repair: vi.fn(async (_id: string, file: string) => ({ path: file, status: "ok" })),
    },
    products: { list: vi.fn(async () => queryResult) },
    inventory: { listSkus: vi.fn(async () => queryResult) },
    seo: { listPages: vi.fn(async () => queryResult), listIssues: vi.fn(async () => queryResult) },
    content: { listBlog: vi.fn(async () => queryResult), listKeywords: vi.fn(async () => queryResult) },
    edm: { listImages: vi.fn(async () => queryResult) },
    categories: {
      get: vi.fn(async () => ({ mode: "feed" })),
      preview: vi.fn(async () => ({ categories: [], uncategorized: 0, multi_matched: 0, candidates: [] })),
      save: vi.fn(async () => ({ categories: [], uncategorized: 0, multi_matched: 0, candidates: [] })),
    },
    folders: {
      list: vi.fn(async () => []), create: vi.fn(async () => []), describe: vi.fn(async () => []),
    },
    schedule: {
      get: vi.fn(async () => ({ config: testSchedule, registered: false, next_runs: [] })),
      save: vi.fn(async (_id: string, config: ScheduleConfig) => ({ config, registered: false, next_runs: [] })),
    },
    runner: { get: vi.fn(async () => ({ runner: null, this_device: { device_id: "cli-test", device_name: "CLI Test" }, is_this_device: false })) },
    invalidate: vi.fn(),
  };
  return { service: service as unknown as CoreService, methods: service };
}

describe("siteindex CLI", () => {
  it("prints help and wraps argument errors as --json output", async () => {
    const help = collect();
    expect(await main([], help.io)).toBe(EXIT.OK);
    expect(help.stdout[0]).toContain("siteindex");

    const invalid = collect();
    expect(await main(["init", "project", "--json"], invalid.io)).toBe(EXIT.BAD_ARGS);
    expect(parseEnvelope(invalid.stdout[0]!).error?.code).toBe("BAD_ARGS");
  });

  it("routes detect, init, feed inspect and run options to core", async () => {
    const { service, methods } = mockService();
    const t = collect(service);
    expect(await main(["detect", "https://example.test", "--json"], t.io)).toBe(EXIT.OK);
    expect(methods.projects.detect).toHaveBeenCalledWith("https://example.test");

    expect(await main(["init", "new-shop", "--url", "https://example.test", "--feed", "https://example.test/feed.xml", "--name", "Example", "--folders", "seo,edm", "--json"], t.io)).toBe(EXIT.OK);
    const input = methods.projects.create.mock.calls[0]?.[0] as CreateProjectInput;
    expect(input.folder_name).toBe("new-shop");
    expect(input.workspace_folders).toEqual(["seo", "edm"]);

    expect(await main(["feed", "inspect", "kingsyard", "--json"], t.io)).toBe(EXIT.OK);
    expect(methods.projects.inspectFeed).toHaveBeenCalledWith([fixtureConfig.crawl.feed_url], { sku_field: "id", category_depth: 2 });

    expect(await main(["run", "kingsyard", "weekly", "--date", "2026-10-25", "--force", "--only", "links", "--json"], t.io)).toBe(EXIT.OK);
    expect(methods.runJob).toHaveBeenLastCalledWith(expect.objectContaining({ job: "weekly", trigger: "cli", date: "2026-10-25", force: true, only: "links" }), expect.any(Function));
  });

  it("supports validate repair, views and all query targets", async () => {
    const { service, methods } = mockService();
    const t = collect(service);
    const repairedReport: ValidationReport = {
      checked_at: "2026-10-26T00:00:00Z",
      trigger: "manual",
      summary: { total: 1, ok: 1, error: 0, missing: 0, conflict_copy: 0 },
      files: [],
    };
    expect(await main(["validate", "kingsyard", "--repair", "--file", "index/seo/links.jsonl", "--json"], t.io)).toBe(EXIT.OK);
    expect(methods.files.repair).not.toHaveBeenCalled();
    expect(methods.files.validate).toHaveBeenCalledWith("kingsyard", "index/seo/links.jsonl");

    const failedReport: ValidationReport = {
      ...repairedReport,
      summary: { total: 1, ok: 0, error: 1, missing: 0, conflict_copy: 0 },
      files: [{ path: "index/seo/links.jsonl", kind: "sync", status: "error", repair: "autofix" }],
    };
    methods.files.validate.mockResolvedValueOnce(failedReport).mockResolvedValueOnce(repairedReport);
    expect(await main(["validate", "kingsyard", "--repair", "--json"], t.io)).toBe(EXIT.OK);
    expect(methods.files.repair).toHaveBeenCalledWith("kingsyard", "index/seo/links.jsonl", "autofix");

    expect(await main(["views", "kingsyard", "--json"], t.io)).toBe(EXIT.OK);
    expect(methods.runJob).toHaveBeenLastCalledWith(expect.objectContaining({ job: "views", trigger: "cli" }), expect.any(Function));

    const targets = ["products", "sku-stock", "seo-pages", "seo-issues", "blog", "keywords", "sku-media"];
    for (const target of targets) {
      expect(await main(["query", "kingsyard", target, "--page", "2", "--size", "20", "--json"], t.io)).toBe(EXIT.OK);
    }
    expect(methods.products.list).toHaveBeenCalledWith("kingsyard", expect.objectContaining({ page: 2, pageSize: 20 }));
  });

  it("upserts JSONL and CSV rows and deletes ledger keys from the fixture project", async () => {
    await copyFixtureProject();
    const t = collect(mockService().service);
    const row = { keyword: " New Keyword ", target_url: null, role: "secondary", intent: "commercial", cluster: "feeders", status: "planned", updated_at: "2026-10-26" };
    expect(await main(["ledger", "upsert", projectPath, "keywords", "--rows", "-", "--json"], { ...t.io, stdin: async () => JSON.stringify(row) + "\n" })).toBe(EXIT.OK);
    const keywords = await readFile(path.join(projectPath, PATHS.keywords), "utf8");
    expect(keywords).toContain('"keyword":"new keyword"');
    expect(await main(["ledger", "delete", projectPath, "keywords", "new keyword", "--json"], t.io)).toBe(EXIT.OK);
    expect((await readFile(path.join(projectPath, PATHS.keywords), "utf8")).toLowerCase()).not.toContain("new keyword");

    const csvInput = "sku,image_role,image_url,alt_text,source,width,height,updated_at\nTEST-CLI,main,https://example.test/image.jpg,Test,cdn,640,480,2026-10-26\n";
    expect(await main(["ledger", "upsert", projectPath, "sku_media", "--rows", "-", "--json"], { ...t.io, stdin: async () => csvInput })).toBe(EXIT.OK);
    expect((await readFile(path.join(projectPath, PATHS.skuMedia), "utf8")).toLowerCase()).toContain("test-cli");
    expect(await main(["ledger", "delete", projectPath, "sku_media", "TEST-CLI", "main", "--json"], t.io)).toBe(EXIT.OK);
  });

  it("renders EDM golden files and includes out-of-stock products only when allowed", async () => {
    await copyFixtureProject();
    const t = collect(mockService().service);
    const args = ["edm", "render", projectPath, "edm/2026-10-20-halloween", "--json"];
    expect(await main(args, t.io)).toBe(EXIT.OK);
    const defaultIncluded = parseEnvelope<{ included: number }>(t.stdout[0]!).data?.included ?? 0;
    expect(await readFile(path.join(projectPath, "edm", "2026-10-20-halloween", "email.html"), "utf8"))
      .toBe(await readFile(expectedEmail, "utf8"));
    expect(await readFile(path.join(projectPath, "edm", "2026-10-20-halloween", "products.json"), "utf8"))
      .toBe(await readFile(expectedProducts, "utf8"));

    expect(await main(["edm", "render", projectPath, "edm/2026-10-20-halloween", "--allow-oos", "--json"], t.io)).toBe(EXIT.OK);
    const output = parseEnvelope<{ included: number }>(t.stdout.at(-1)!);
    expect(output.data?.included).toBeGreaterThan(defaultIncluded);
  });

  it("supports categories, folders, schedule and runner operations", async () => {
    const { service, methods } = mockService();
    await mkdir(path.join(projectPath, PATHS.index), { recursive: true });
    const customFolder = { name: "cli-campaigns", default: false };
    const config: SiteConfig = {
      ...fixtureConfig,
      schedule: testSchedule,
      workspace_folders: [
        ...DEFAULT_WORKSPACE_FOLDERS.map((name) => ({ name, default: true })),
        customFolder,
      ],
    };
    await writeFile(path.join(projectPath, PATHS.site), JSON.stringify(config, null, 2) + "\n", "utf8");
    await mkdir(path.join(projectPath, customFolder.name));
    const trash = vi.fn(async () => undefined);
    const t = collect(service, { trash });
    expect(await main(["categories", "preview", projectPath, "--json"], t.io)).toBe(EXIT.OK);
    expect(await main(["categories", "apply", projectPath, "--json"], t.io)).toBe(EXIT.OK);
    expect(methods.categories.preview).toHaveBeenCalled();
    expect(methods.categories.save).toHaveBeenCalled();

    expect(await main(["folders", "list", projectPath, "--json"], t.io)).toBe(EXIT.OK);
    expect(await main(["folders", "delete", projectPath, "seo", "--json"], t.io)).toBe(EXIT.BAD_ARGS);
    expect(await main(["folders", "create", projectPath, "cli-campaigns", "--description", "CLI campaigns", "--json"], t.io)).toBe(EXIT.OK);
    expect(await main(["folders", "describe", projectPath, "cli-campaigns", "--description", "Updated description", "--json"], t.io)).toBe(EXIT.OK);
    expect(await main(["folders", "delete", projectPath, "cli-campaigns", "--json"], t.io)).toBe(EXIT.OK);
    expect(methods.folders.list).toHaveBeenCalled();
    expect(methods.folders.create).toHaveBeenCalledWith(projectPath, "cli-campaigns", "CLI campaigns");
    expect(methods.folders.describe).toHaveBeenCalledWith(projectPath, "cli-campaigns", "Updated description");
    expect(trash).toHaveBeenCalledWith(path.join(projectPath, customFolder.name));

    expect(await main(["schedule", "install", projectPath, "--json"], t.io)).toBe(EXIT.OK);
    expect(await main(["schedule", "remove", projectPath, "--json"], t.io)).toBe(EXIT.OK);
    expect(await main(["schedule", "list", projectPath, "--json"], t.io)).toBe(EXIT.OK);
    const savedSchedule = methods.schedule.save.mock.calls.at(-1)?.[1];
    expect(savedSchedule?.daily.enabled).toBe(false);
    expect(methods.schedule.get).toHaveBeenCalled();

    expect(await main(["runner", "claim", projectPath, "--json"], t.io)).toBe(EXIT.OK);
    expect(JSON.parse(await readFile(path.join(projectPath, PATHS.runner), "utf8")).device_id).toBe("cli-test");
    expect(await main(["runner", "show", projectPath, "--json"], t.io)).toBe(EXIT.OK);
    expect(methods.runner.get).toHaveBeenCalled();
  }, 30000);

  it("lists, syncs and installs packaged skills", async () => {
    const targetDir = path.join(tempRoot, "codex-skills");
    await mkdir(targetDir, { recursive: true });
    const t = collect(mockService().service, {
      skillsDir: skillsFixture,
      settings: {
        projects_root: tempRoot,
        cache_dir: path.join(tempRoot, "cache"),
        skill_platforms: [{ id: "test-codex", name: "Test Codex", dir: targetDir, detected: true }],
      },
    });
    expect(await main(["skills", "list", "--json"], t.io)).toBe(EXIT.OK);
    const list = parseEnvelope<SkillInfo[]>(t.stdout.at(-1)!).data ?? [];
    expect(list.length).toBeGreaterThan(0);
    expect(await main(["skills", "sync", projectPath, "--json"], t.io)).toBe(EXIT.OK);
    expect(await readFile(path.join(projectPath, PATHS.skillsManifest), "utf8")).toContain('"skills"');
    expect(await main(["skills", "install", list[0]!.name, "--platform", "test-codex", "--json"], t.io)).toBe(EXIT.OK);
    expect(await readFile(path.join(targetDir, list[0]!.name, "SKILL.md"), "utf8")).toContain("name:");
  }, 30000);
});
