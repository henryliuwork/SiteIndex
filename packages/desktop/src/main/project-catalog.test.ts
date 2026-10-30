import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PATHS, type AppSettings } from "@siteindex/shared";
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

  it("deduplicates the same project registered by projects_root and extra_projects", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "siteindex-projects-overlap-"));
    roots.push(root);
    const projectsRoot = path.join(root, "projects");
    const alpha = await createProject(path.join(projectsRoot, "alpha"));
    const catalogInstance = createProjectCatalog(() => undefined, () => undefined);
    catalog = catalogInstance;

    const entries = await catalogInstance.refresh(settings(projectsRoot, [alpha]));

    expect(entries).toEqual([{ id: "alpha", path: alpha }]);
    expect(catalogInstance.resolveProject("alpha")).toBe(alpha);
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
});
