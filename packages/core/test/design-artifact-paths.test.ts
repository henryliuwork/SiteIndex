import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pathsFor, type DesignTokens, type ProjectLayout } from "@siteindex/shared";
import { createCoreService } from "../src";

const TEMP_DIRS: string[] = [];

const tokens: DesignTokens = {
  extracted_at: "2026-11-06T00:00:00.000Z",
  source_pages: ["https://demo.example.test/"],
  css_variables: {},
  color: { primary: null, text: null, background: null, palette: [] },
  typography: { font_families: {}, scale: {} },
  spacing: [],
  radius: [],
  shadow: [],
  components: {},
  assets: {},
};

async function makeProject(layout: ProjectLayout, options: { workspaceMetadata?: boolean; artifacts?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-design-artifacts-"));
  TEMP_DIRS.push(root);
  const projectPath = path.join(root, "project");
  const paths = pathsFor(layout);
  await mkdir(path.join(projectPath, paths.index), { recursive: true });
  await writeFile(path.join(projectPath, paths.site), JSON.stringify({
    schema_version: "1.0",
    domain: "demo.example.test",
    ...(layout === "workspace" && options.workspaceMetadata ? {
      workspace: { version: "1.0", sections: ["01-brand"], esp_presets: [] },
    } : {}),
  }) + "\n", "utf8");
  if (options.artifacts) {
    await mkdir(path.dirname(path.join(projectPath, paths.designTokens)), { recursive: true });
    await writeFile(path.join(projectPath, paths.designTokens), JSON.stringify(tokens) + "\n", "utf8");
    await writeFile(path.join(projectPath, paths.designBrand), "# Synthetic design notes\n", "utf8");
  }
  const service = createCoreService({
    resolveProject: () => projectPath,
    deviceId: "design-artifact-path-test",
    cacheDir: path.join(root, "cache"),
  });
  return { projectPath, paths, service };
}

afterEach(async () => {
  await Promise.all(TEMP_DIRS.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("design.get artifact paths", () => {
  it("returns legacy tokens and brand paths and reads legacy tokens", async () => {
    const { projectPath, paths, service } = await makeProject("legacy", { artifacts: true });

    const result = await service.design.get("demo");

    expect(result.tokens).toEqual(tokens);
    expect(result.artifact_paths).toEqual({ tokens: paths.designTokens, brand: paths.designBrand });
    expect(await readFile(path.join(projectPath, result.artifact_paths!.brand), "utf8"))
      .toBe("# Synthetic design notes\n");
  });

  it("returns workspace tokens and brand paths when workspace metadata is present", async () => {
    const { projectPath, paths, service } = await makeProject("workspace", {
      workspaceMetadata: true,
      artifacts: true,
    });

    const result = await service.design.get("demo");

    expect(result.tokens).toEqual(tokens);
    expect(result.artifact_paths).toEqual({ tokens: paths.designTokens, brand: paths.designBrand });
    expect(result.artifact_paths).toEqual({
      tokens: "_site-index/design/tokens.json",
      brand: "_site-index/design/brand.md",
    });
    await expect(access(path.join(projectPath, "index"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resolves workspace paths from the data directory when imported site metadata is missing", async () => {
    const { projectPath, paths, service } = await makeProject("workspace", { artifacts: true });

    const result = await service.design.get("demo");

    expect(JSON.parse(await readFile(path.join(projectPath, paths.site), "utf8"))).not.toHaveProperty("workspace");
    expect(result.artifact_paths).toEqual({ tokens: paths.designTokens, brand: paths.designBrand });
    expect(result.tokens).toEqual(tokens);
  });

  it("returns resolved paths for missing files without creating or changing project files", async () => {
    const { projectPath, paths, service } = await makeProject("workspace", { workspaceMetadata: true });
    const userReadme = "# User section\nKeep this unchanged.\n";
    await writeFile(path.join(projectPath, paths.readme), userReadme, "utf8");
    const before = await readdir(projectPath);

    const result = await service.design.get("demo");

    expect(result.tokens).toBeNull();
    expect(result.screenshots).toEqual([]);
    expect(result.artifact_paths).toEqual({ tokens: paths.designTokens, brand: paths.designBrand });
    expect(await readdir(projectPath)).toEqual(before);
    expect(await readFile(path.join(projectPath, paths.readme), "utf8")).toBe(userReadme);
    await expect(access(path.join(projectPath, paths.designTokens))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(path.join(projectPath, paths.designBrand))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
