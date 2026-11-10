import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCoreService, type CoreService } from "@siteindex/core";
import { pathsFor, type AppSettings, type CreateWorkspaceOnlyInput } from "@siteindex/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProjectCatalog, type ProjectCatalog } from "../project-catalog.js";
import { createProjectsHandlers } from "./projects.js";
import type { IpcContext } from "./context.js";

const templateDir = fileURLToPath(new URL("../../../../../templates/project/", import.meta.url));
const temporaryRoots: string[] = [];
const catalogs: ProjectCatalog[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(catalogs.splice(0).map((catalog) => catalog.close()));
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function settings(projectsRoot: string): AppSettings {
  return {
    device_id: "fixture-device",
    device_name: "Fixture Device",
    projects_root: projectsRoot,
    extra_projects: [],
    cache_dir: path.join(projectsRoot, "cache"),
    browser: { channel: "msedge", executable_path: null },
    notify: { on_failure: false, on_success: false, oos_threshold: null, dingtalk_webhook: null },
    skill_platforms: [],
    conflict_patterns: [],
  };
}

async function createHarness(root: string, projectsRoot: string) {
  let savedSettings = settings(projectsRoot);
  const settingsStore = {
    get: vi.fn(async () => savedSettings),
    set: vi.fn(async (patch: Partial<AppSettings>) => {
      savedSettings = { ...savedSettings, ...patch };
      return savedSettings;
    }),
  };
  let core: CoreService | null = null;
  const catalog = createProjectCatalog(
    (projectPath) => core?.invalidate(projectPath),
    () => undefined,
  );
  catalogs.push(catalog);
  core = createCoreService({
    resolveProject: catalog.resolveProject,
    listRegisteredProjects: async () => catalog.refresh(await settingsStore.get()),
    deviceId: "fixture-device",
    cacheDir: path.join(root, "cache"),
    templateDir,
  });
  const jobs = { run: vi.fn(async () => ({ runId: "should-not-run" })) };
  const notifyProjectChanged = vi.fn();
  const settingsChanged = vi.fn(async () => undefined);
  const context = {
    core,
    projects: catalog,
    settings: settingsStore,
    settingsChanged,
    notifyProjectChanged,
    jobs,
  } as unknown as IpcContext;
  return { core, catalog, context, jobs, notifyProjectChanged, settingsChanged, settingsStore };
}

function input(
  projectsRoot: string,
  folderName: string,
  url = "https://fixture.example.test",
): CreateWorkspaceOnlyInput {
  return {
    url,
    brand: { name: "Fixture Workspace" },
    markets: ["US"],
    projects_root: projectsRoot,
    folder_name: folderName,
    workspace: { enabled: true, platform: "woocommerce", esp_presets: ["mailchimp"] },
  };
}

function fixtureDomain(root: string): string {
  const suffix = path
    .basename(root)
    .replace(/[^a-z0-9-]/gi, "-")
    .toLowerCase();
  return `https://${suffix}.example.test`;
}

describe("projects.createWorkspaceOnly Desktop flow", () => {
  it("registers a created workspace under extra_projects and notifies the UI without running a Job", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "siteindex-workspace-only-ipc-"));
    temporaryRoots.push(root);
    const registeredRoot = path.join(root, "registered");
    const selectedRoot = path.join(root, "selected");
    await Promise.all([mkdir(registeredRoot), mkdir(selectedRoot)]);
    const harness = await createHarness(root, registeredRoot);
    const domain = fixtureDomain(root);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const created = await createProjectsHandlers(harness.context)["projects.createWorkspaceOnly"]?.(
      input(selectedRoot, "workspace-demo", domain),
    );
    const workspacePath = path.join(selectedRoot, "workspace-demo");
    const canonicalWorkspacePath = await realpath(workspacePath);
    const workspacePaths = pathsFor("workspace");

    expect(created).toEqual({ id: "workspace-demo" });
    expect((await harness.settingsStore.get()).extra_projects).toEqual([workspacePath]);
    expect(await harness.catalog.refresh(await harness.settingsStore.get())).toEqual([
      { id: "workspace-demo", path: canonicalWorkspacePath },
    ]);
    expect(harness.catalog.resolveProject("workspace-demo")).toBe(canonicalWorkspacePath);
    await expect(readFile(path.join(workspacePath, workspacePaths.site), "utf8")).resolves.toContain(
      new URL(domain).hostname,
    );
    await expect(readFile(path.join(workspacePath, workspacePaths.skillsManifest), "utf8")).resolves.toContain(
      "siteindex-data",
    );
    await expect(
      readFile(path.join(workspacePath, workspacePaths.skillsDir, "presets", "esp.mailchimp.md"), "utf8"),
    ).resolves.toBeTruthy();
    expect(harness.notifyProjectChanged).toHaveBeenCalledWith("workspace-demo");
    expect(harness.settingsChanged).toHaveBeenCalledWith(await harness.settingsStore.get(), false);
    expect(harness.jobs.run).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  }, 30_000);

  it("serializes same-domain requests so Core sees the first workspace in its registration callback", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "siteindex-workspace-only-race-"));
    temporaryRoots.push(root);
    const registeredRoot = path.join(root, "registered");
    const selectedRoot = path.join(root, "selected");
    await Promise.all([mkdir(registeredRoot), mkdir(selectedRoot)]);
    let savedSettings = settings(registeredRoot);
    const settingsStore = {
      get: vi.fn(async () => savedSettings),
      set: vi.fn(async (patch: Partial<AppSettings>) => {
        savedSettings = { ...savedSettings, ...patch };
        return savedSettings;
      }),
    };
    const catalog = createProjectCatalog(
      () => undefined,
      () => undefined,
    );
    catalogs.push(catalog);
    const createWorkspaceOnly = vi.fn(async (request: CreateWorkspaceOnlyInput) => {
      const requestedDomain = new URL(request.url).hostname.replace(/^www\./i, "").toLowerCase();
      const registered = await catalog.refresh(await settingsStore.get());
      for (const entry of registered) {
        const workspaceSite = path.join(entry.path, pathsFor("workspace").site);
        const legacySite = path.join(entry.path, pathsFor("legacy").site);
        const sitePath = await readFile(workspaceSite, "utf8").then(
          () => workspaceSite,
          () => legacySite,
        );
        const site = JSON.parse(await readFile(sitePath, "utf8")) as { domain?: string };
        if (site.domain?.toLowerCase() === requestedDomain) {
          throw { code: "FOLDER_EXISTS", message: "该网站已登记。" };
        }
      }
      const id = request.folder_name.trim();
      const workspacePath = path.resolve(request.projects_root, id);
      await mkdir(path.join(workspacePath, pathsFor("workspace").index), { recursive: true });
      await writeFile(
        path.join(workspacePath, pathsFor("workspace").site),
        `${JSON.stringify({ domain: requestedDomain })}\n`,
        "utf8",
      );
      return { id };
    });
    const jobs = { run: vi.fn(async () => ({ runId: "should-not-run" })) };
    const notifyProjectChanged = vi.fn();
    const core = { projects: { createWorkspaceOnly }, invalidate: vi.fn() } as unknown as CoreService;
    const context = {
      core,
      projects: catalog,
      settings: settingsStore,
      settingsChanged: vi.fn(async () => undefined),
      notifyProjectChanged,
      jobs,
    } as unknown as IpcContext;
    const handler = createProjectsHandlers(context)["projects.createWorkspaceOnly"]!;
    const domain = fixtureDomain(root);
    const domainHost = new URL(domain).hostname;

    const results = await Promise.allSettled([
      handler(input(selectedRoot, "first-workspace", domain)),
      handler(input(selectedRoot, "second-workspace", `http://www.${domainHost}/catalog`)),
    ]);

    expect(results[0]).toMatchObject({ status: "fulfilled", value: { id: "first-workspace" } });
    expect(results[1]).toMatchObject({ status: "rejected", reason: { code: "FOLDER_EXISTS" } });
    expect(await readdir(selectedRoot)).toEqual(["first-workspace"]);
    expect((await settingsStore.get()).extra_projects).toEqual([path.join(selectedRoot, "first-workspace")]);
    expect(notifyProjectChanged).toHaveBeenCalledTimes(1);
    expect(jobs.run).not.toHaveBeenCalled();
    expect(createWorkspaceOnly).toHaveBeenCalledTimes(2);
  }, 30_000);
});
