import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathsFor, type CreateWorkspaceOnlyInput } from "@siteindex/shared";
import { afterEach, describe, expect, it } from "vitest";
import { createCoreService } from "../src/service";
import { readJsonl } from "../src/io/jsonl";

const TEMP_DIRS: string[] = [];
const paths = pathsFor("workspace");

function service(projectsRoot: string) {
  return createCoreService({
    resolveProject: (id) => path.join(projectsRoot, id),
    deviceId: "workspace-only-create-test",
    cacheDir: path.join(os.tmpdir(), "siteindex-workspace-only-create-cache"),
  });
}

function createInput(projectsRoot: string, folder_name: string, url = "https://demo-workspace.test"): CreateWorkspaceOnlyInput {
  return {
    url,
    brand: { name: "Demo Workspace", tagline: "Synthetic workspace-only project" },
    markets: ["US"],
    projects_root: projectsRoot,
    folder_name,
    workspace: { enabled: true, platform: "woocommerce", esp_presets: [] },
  };
}

afterEach(async () => {
  await Promise.all(TEMP_DIRS.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("projects.createWorkspaceOnly", () => {
  it("creates workspace files and returns without running initialization jobs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-workspace-only-"));
    TEMP_DIRS.push(root);
    const result = await service(root).projects.createWorkspaceOnly(createInput(root, "demo"));
    const project = path.join(root, "demo");
    const config = JSON.parse(await readFile(path.join(project, paths.site), "utf8")) as {
      domain: string;
      workspace?: { enabled?: boolean; version: string };
    };

    expect(result).toEqual({ id: "demo" });
    expect(config).toMatchObject({ domain: "demo-workspace.test", workspace: { version: "1.0" } });
    expect(await readJsonl(path.join(project, paths.runs))).toEqual([]);
    await expect(access(path.join(project, "index", "site.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(root)).toEqual(["demo"]);
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

  it("rejects a folder name that could escape projects_root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-workspace-only-path-"));
    TEMP_DIRS.push(root);
    await expect(service(root).projects.createWorkspaceOnly(createInput(root, ".."))).rejects.toMatchObject({ code: "UNKNOWN" });
    expect(await readdir(root)).toEqual([]);
  });
});
