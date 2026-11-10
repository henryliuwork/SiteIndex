import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PATHS, pathsFor, type AppSettings } from "@siteindex/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProjectCatalog, type ProjectCatalog } from "./project-catalog.js";

const roots: string[] = [];
let catalog: ProjectCatalog | null = null;

function settings(projectsRoot: string, extraProjects: string[] = []): AppSettings {
  return {
    device_id: "test-device",
    device_name: "Test Device",
    projects_root: projectsRoot,
    extra_projects: extraProjects,
    cache_dir: path.join(projectsRoot, "cache"),
    browser: { channel: "msedge", executable_path: null },
    notify: { on_failure: true, on_success: false, oos_threshold: null, dingtalk_webhook: null },
    skill_platforms: [],
    conflict_patterns: [],
  };
}

async function createProject(directory: string): Promise<string> {
  const projectPath = path.resolve(directory);
  await mkdir(path.join(projectPath, PATHS.index), { recursive: true });
  await writeFile(path.join(projectPath, PATHS.site), "{}\n", "utf8");
  await writeFile(path.join(projectPath, PATHS.readme), "README\n", "utf8");
  return realpath(projectPath);
}

async function createWorkspaceProject(directory: string): Promise<string> {
  const projectPath = path.resolve(directory);
  const workspacePaths = pathsFor("workspace");
  await mkdir(path.join(projectPath, workspacePaths.index), { recursive: true });
  await writeFile(path.join(projectPath, workspacePaths.site), "{}\n", "utf8");
  await writeFile(path.join(projectPath, PATHS.readme), "README\n", "utf8");
  return realpath(projectPath);
}

afterEach(async () => {
  await catalog?.close();
  catalog = null;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("project catalog", () => {
  it("scans configured roots and extra projects and resolves only discovered ids", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "siteindex-projects-"));
    roots.push(root);
    const projectsRoot = path.join(root, "projects");
    const extraRoot = path.join(root, "extra");
    const alpha = await createProject(path.join(projectsRoot, "alpha"));
    const extra = await createProject(path.join(extraRoot, "extra"));
    await mkdir(path.join(projectsRoot, "not-a-project"), { recursive: true });
    const catalogInstance = createProjectCatalog(
      () => undefined,
      () => undefined,
    );
    catalog = catalogInstance;

    const entries = await catalogInstance.refresh(settings(projectsRoot, [extra]));

    expect(entries.map(({ id }) => id)).toEqual(["alpha", "extra"]);
    expect(catalogInstance.resolveProject("alpha")).toBe(alpha);
    expect(catalogInstance.resolveProject("extra")).toBe(extra);
    expect(() => catalogInstance.resolveProject("missing")).toThrowError("找不到指定项目。");
  });

  it("discovers legacy and workspace projects from both registered roots and extra paths", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "siteindex-projects-layouts-"));
    roots.push(root);
    const projectsRoot = path.join(root, "projects");
    const legacy = await createProject(path.join(projectsRoot, "legacy"));
    const workspace = await createWorkspaceProject(path.join(root, "workspace", "workspace"));
    const catalogInstance = createProjectCatalog(
      () => undefined,
      () => undefined,
    );
    catalog = catalogInstance;

    const entries = await catalogInstance.refresh(settings(projectsRoot, [workspace]));

    expect(entries.map(({ id }) => id)).toEqual(["legacy", "workspace"]);
    expect(catalogInstance.resolveProject("legacy")).toBe(legacy);
    expect(catalogInstance.resolveProject("workspace")).toBe(workspace);
    await expect(catalogInstance.resolveExistingPath(workspace)).resolves.toBe(workspace);
  });

  it("deduplicates the same project registered by projects_root and extra_projects", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "siteindex-projects-overlap-"));
    roots.push(root);
    const projectsRoot = path.join(root, "projects");
    const alpha = await createProject(path.join(projectsRoot, "alpha"));
    const catalogInstance = createProjectCatalog(
      () => undefined,
      () => undefined,
    );
    catalog = catalogInstance;

    const entries = await catalogInstance.refresh(settings(projectsRoot, [alpha]));

    expect(entries).toEqual([{ id: "alpha", path: alpha }]);
    expect(catalogInstance.resolveProject("alpha")).toBe(alpha);
  });

  it("deduplicates a workspace project registered in both projects_root and extra_projects", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "siteindex-workspace-project-overlap-"));
    roots.push(root);
    const projectsRoot = path.join(root, "projects");
    const workspace = await createWorkspaceProject(path.join(projectsRoot, "workspace"));
    const catalogInstance = createProjectCatalog(
      () => undefined,
      () => undefined,
    );
    catalog = catalogInstance;

    const entries = await catalogInstance.refresh(settings(projectsRoot, [workspace]));

    expect(entries).toEqual([{ id: "workspace", path: workspace }]);
    expect(catalogInstance.resolveProject("workspace")).toBe(workspace);
  });

  it("hides a registered root project without changing its files, then restores it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "siteindex-projects-hidden-"));
    roots.push(root);
    const projectsRoot = path.join(root, "projects");
    const alpha = await createProject(path.join(projectsRoot, "alpha"));
    catalog = createProjectCatalog(
      () => undefined,
      () => undefined,
    );

    expect(await catalog.refresh({ ...settings(projectsRoot), hidden_projects: [alpha] })).toEqual([]);
    expect(await catalog.refresh(settings(projectsRoot))).toEqual([{ id: "alpha", path: alpha }]);
  });

  it("debounces index and README changes, invalidates the snapshot, and emits the project id", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "siteindex-watch-"));
    roots.push(root);
    const projectPath = await createProject(path.join(root, "projects", "alpha"));
    const changed: string[] = [];
    const invalidated: string[] = [];
    const onChanged = vi.fn((id: string) => {
      changed.push(id);
    });
    const catalogInstance = createProjectCatalog((project) => invalidated.push(project), onChanged);
    catalog = catalogInstance;
    await catalogInstance.refresh(settings(path.join(root, "projects")));

    const changedEvent = new Promise<string>((resolveChanged) => {
      onChanged.mockImplementation((id) => {
        changed.push(id);
        resolveChanged(id);
      });
    });
    await Promise.all([
      writeFile(path.join(projectPath, PATHS.site), '{"domain":"example.test"}\n', "utf8"),
      writeFile(path.join(projectPath, PATHS.readme), "Changed\n", "utf8"),
    ]);

    await expect(changedEvent).resolves.toBe("alpha");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
    expect(changed).toEqual(["alpha"]);
    expect(invalidated).toEqual([projectPath]);
  }, 5_000);

  it("watches workspace data changes and emits the project id", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "siteindex-workspace-watch-"));
    roots.push(root);
    const projectPath = await createWorkspaceProject(path.join(root, "projects", "workspace"));
    const changed: string[] = [];
    const invalidated: string[] = [];
    let resolveChanged!: (id: string) => void;
    const changedEvent = new Promise<string>((resolve) => {
      resolveChanged = resolve;
    });
    const catalogInstance = createProjectCatalog(
      (project) => invalidated.push(project),
      (id) => {
        changed.push(id);
        resolveChanged(id);
      },
    );
    catalog = catalogInstance;
    await catalogInstance.refresh(settings(path.join(root, "projects")));

    await writeFile(path.join(projectPath, pathsFor("workspace").site), '{"domain":"fixture.example.test"}\n', "utf8");

    await expect(changedEvent).resolves.toBe("workspace");
    expect(changed).toEqual(["workspace"]);
    expect(invalidated).toEqual([projectPath]);
  }, 5_000);
});
