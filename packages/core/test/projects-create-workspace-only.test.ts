import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathsFor, type CreateWorkspaceOnlyInput } from "@siteindex/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCoreService, type CoreServiceContext } from "../src/service";
import { readJsonl } from "../src/io/jsonl";

const TEMP_DIRS: string[] = [];
const paths = pathsFor("workspace");

function service(projectsRoot: string, listRegisteredProjects?: CoreServiceContext["listRegisteredProjects"]) {
  return createCoreService({
    resolveProject: (id) => path.join(projectsRoot, id),
    deviceId: "workspace-only-create-test",
    cacheDir: path.join(os.tmpdir(), "siteindex-workspace-only-create-cache"),
    ...(listRegisteredProjects ? { listRegisteredProjects } : {}),
  });
}

function createInput(
  projectsRoot: string,
  folder_name: string,
  url = "https://demo-workspace.test",
  esp_presets: string[] = [],
): CreateWorkspaceOnlyInput {
  return {
    url,
    brand: { name: "Demo Workspace", tagline: "Synthetic workspace-only project" },
    markets: ["US"],
    projects_root: projectsRoot,
    folder_name,
    workspace: { enabled: true, platform: "woocommerce", esp_presets },
  };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(TEMP_DIRS.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("projects.createWorkspaceOnly", () => {
  it("creates workspace files without network access or initialization jobs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-workspace-only-"));
    TEMP_DIRS.push(root);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await service(root).projects.createWorkspaceOnly(createInput(root, "demo", undefined, ["esp.mailchimp"]));
    const project = path.join(root, "demo");
    const config = JSON.parse(await readFile(path.join(project, paths.site), "utf8")) as {
      domain: string;
      workspace?: { enabled?: boolean; version: string; esp_presets: string[] };
    };
    const manifest = JSON.parse(await readFile(path.join(project, paths.index, "workspace.json"), "utf8")) as {
      esp_presets: string[];
    };

    expect(result).toEqual({ id: "demo" });
    expect(config).toMatchObject({
      domain: "demo-workspace.test",
      workspace: { version: "1.0", esp_presets: ["mailchimp"] },
    });
    expect(manifest.esp_presets).toEqual(["mailchimp"]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await readJsonl(path.join(project, paths.runs))).toEqual([]);
    await expect(access(path.join(project, "index", "site.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(root)).toEqual(["demo"]);
  }, 30_000);

  it("accepts the canonical Mailchimp preset ID", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-workspace-only-mailchimp-canonical-"));
    TEMP_DIRS.push(root);
    const result = await service(root).projects.createWorkspaceOnly(createInput(root, "demo", undefined, ["mailchimp"]));
    const project = path.join(root, "demo");
    const config = JSON.parse(await readFile(path.join(project, paths.site), "utf8")) as {
      workspace?: { esp_presets: string[] };
    };
    const manifest = JSON.parse(await readFile(path.join(project, paths.index, "workspace.json"), "utf8")) as {
      esp_presets: string[];
    };

    expect(result.id).toBe("demo");
    expect(config.workspace?.esp_presets).toEqual(["mailchimp"]);
    expect(manifest.esp_presets).toEqual(["mailchimp"]);
    expect(await readFile(path.join(project, paths.skillsDir, "presets", "esp.mailchimp.md"), "utf8")).toBeTruthy();
  }, 30_000);

  it("blocks a second workspace for the same normalized domain before creating its folder", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-workspace-only-duplicate-"));
    TEMP_DIRS.push(root);
    const api = service(root);
    await api.projects.createWorkspaceOnly(createInput(root, "first"));

    await expect(api.projects.createWorkspaceOnly(createInput(root, "second", "http://www.DEMO-WORKSPACE.test/catalog")))
      .rejects.toMatchObject({ code: "FOLDER_EXISTS" });
    expect(await readdir(root)).toEqual(["first"]);
  }, 30_000);

  it("checks legacy projects for a normalized same-domain duplicate and preserves their config", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-workspace-only-legacy-duplicate-"));
    TEMP_DIRS.push(root);
    const legacyConfigPath = path.join(root, "legacy", pathsFor("legacy").site);
    await mkdir(path.dirname(legacyConfigPath), { recursive: true });
    const legacyConfig = '{"domain":"demo-workspace.test"}\n';
    await writeFile(legacyConfigPath, legacyConfig, "utf8");

    await expect(service(root).projects.createWorkspaceOnly(
      createInput(root, "new-workspace", "http://www.DEMO-WORKSPACE.test/catalog"),
    )).rejects.toMatchObject({ code: "FOLDER_EXISTS" });

    expect(await readFile(legacyConfigPath, "utf8")).toBe(legacyConfig);
    expect(await readdir(root)).toEqual(["legacy"]);
  }, 30_000);

  it("checks the Desktop registration callback for same-domain duplicates outside projects_root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-workspace-only-registered-duplicate-"));
    TEMP_DIRS.push(root);
    const registeredProject = path.join(root, "catalog", "registered-demo");
    const registeredConfigPath = path.join(registeredProject, paths.site);
    await mkdir(path.dirname(registeredConfigPath), { recursive: true });
    const registeredConfig = '{"domain":"demo-workspace.test"}\n';
    await writeFile(registeredConfigPath, registeredConfig, "utf8");
    const projectsRoot = path.join(root, "projects-root");
    await mkdir(projectsRoot);
    const api = service(projectsRoot, async () => [{ id: "registered-demo", path: registeredProject }]);

    await expect(api.projects.createWorkspaceOnly(
      createInput(projectsRoot, "new-workspace", "http://www.DEMO-WORKSPACE.test/catalog"),
    )).rejects.toMatchObject({ code: "FOLDER_EXISTS" });

    expect(await readFile(registeredConfigPath, "utf8")).toBe(registeredConfig);
    expect(await readdir(projectsRoot)).toEqual([]);
  }, 30_000);

  it("refuses a non-empty destination without replacing user files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-workspace-only-nonempty-"));
    TEMP_DIRS.push(root);
    const target = path.join(root, "target");
    await mkdir(target);
    await writeFile(path.join(target, "notes.txt"), "preserve this user file\n", "utf8");

    await expect(service(root).projects.createWorkspaceOnly(
      createInput(root, "target", "https://another-site.test"),
    )).rejects.toMatchObject({ code: "WORKSPACE_NOT_EMPTY" });
    expect(await readdir(target)).toEqual(["notes.txt"]);
    expect(await readFile(path.join(target, "notes.txt"), "utf8")).toBe("preserve this user file\n");
  }, 30_000);

  it("rejects a folder name that could escape projects_root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-workspace-only-path-"));
    TEMP_DIRS.push(root);
    await expect(service(root).projects.createWorkspaceOnly(createInput(root, ".."))).rejects.toMatchObject({ code: "UNKNOWN" });
    expect(await readdir(root)).toEqual([]);
  });
});
