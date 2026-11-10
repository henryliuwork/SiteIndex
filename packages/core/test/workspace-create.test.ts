import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathsFor, type SiteConfig, type WorkspaceCreateInput } from "@siteindex/shared";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspaceFiles } from "../src/workspace/create";
import { createCoreService } from "../src/service";

const TEMP_DIRS: string[] = [];
const workspacePaths = pathsFor("workspace");

function service() {
  return createCoreService({
    resolveProject: () => "",
    deviceId: "workspace-create-test",
    cacheDir: path.join(os.tmpdir(), "siteindex-workspace-create-cache"),
  });
}

function input(targetDir: string): WorkspaceCreateInput {
  return {
    targetDir,
    domain: "https://www.example-shop.test",
    brand: { name: "Example Shop", tagline: "Synthetic test brand" },
    platform: "magento2",
    markets: ["US", "CA"],
    esp_presets: ["mailchimp"],
  };
}

afterEach(async () => {
  await Promise.all(TEMP_DIRS.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("workspace.create", () => {
  it("creates the workspace template, empty data files, blank environment keys and automatic blocks", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-workspace-create-"));
    TEMP_DIRS.push(root);
    const target = path.join(root, "project");
    await mkdir(path.join(target, ".git"), { recursive: true });

    const result = await service().workspace.create(input(target));
    const config = JSON.parse(await readFile(path.join(target, workspacePaths.site), "utf8")) as SiteConfig;
    const manifest = JSON.parse(await readFile(path.join(target, workspacePaths.index, "workspace.json"), "utf8")) as {
      esp_presets: string[];
      paths: Record<string, string>;
      sections: { id: string; dir: string }[];
    };
    const skills = JSON.parse(await readFile(path.join(target, workspacePaths.skillsManifest), "utf8")) as {
      skills: { name: string; version: string }[];
    };
    const readme = await readFile(path.join(target, "README.md"), "utf8");
    const agents = await readFile(path.join(target, "AGENTS.md"), "utf8");
    const claude = await readFile(path.join(target, "CLAUDE.md"), "utf8");
    const projectEntries = await readdir(target);

    expect(result.path).toBe(target);
    expect(result.created).toContain("_site-index/site.json");
    expect(config).toMatchObject({
      domain: "example-shop.test",
      platform: "magento",
      markets: ["US", "CA"],
      workspace: { version: "1.0", esp_presets: ["mailchimp"] },
      crawl: { feed_url: [] },
    });
    expect(manifest.esp_presets).toEqual(["mailchimp"]);
    expect(manifest.paths["seo.blog"]).toBe("03-seo/blog");
    expect(skills.skills.length).toBeGreaterThan(0);
    expect(skills.skills.some((skill) => skill.name === "edm-builder")).toBe(false);
    expect(await readFile(path.join(target, ".env"), "utf8")).toBe("wp_base_url=\nwp_username=\nwp_app_password=\n");
    expect(await readFile(path.join(target, ".gitignore"), "utf8")).toContain(".env");
    expect(readme).toContain("workspace-map");
    expect(readme).toContain("03-seo/blog");
    expect(readme).toContain("Example Shop");
    expect(agents).toContain('id="agents-core"');
    expect(agents).toContain('id="esp-presets"');
    expect(claude).toBe("@AGENTS.md\n");
    expect(await readFile(path.join(target, workspacePaths.skus), "utf8")).toBe("");
    expect(await readFile(path.join(target, workspacePaths.dailySummary), "utf8")).toContain("date,category,total");
    expect(await readFile(path.join(target, workspacePaths.skillsDir, "presets", "esp.mailchimp.md"), "utf8")).toBeTruthy();
    expect(projectEntries).toContain(".git");
    for (const section of manifest.sections) expect(projectEntries).toContain(section.dir);
    expect(projectEntries).toContain("_outputs");
    expect(projectEntries).toContain("_archive");
  });

  it("accepts the New Project Wizard ESP preset ID and persists its canonical manifest ID", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-workspace-preset-alias-"));
    TEMP_DIRS.push(root);
    const target = path.join(root, "project");
    await mkdir(target);

    await service().workspace.create({ ...input(target), esp_presets: ["esp.mailchimp"] });

    const config = JSON.parse(await readFile(path.join(target, workspacePaths.site), "utf8")) as SiteConfig;
    const manifest = JSON.parse(await readFile(path.join(target, workspacePaths.index, "workspace.json"), "utf8")) as {
      esp_presets: string[];
    };
    expect(config.workspace?.esp_presets).toEqual(["mailchimp"]);
    expect(manifest.esp_presets).toEqual(["mailchimp"]);
    expect(await readFile(path.join(target, workspacePaths.skillsDir, "presets", "esp.mailchimp.md"), "utf8")).toBeTruthy();
  });

  it("rejects unsupported and path-like preset IDs before writing workspace files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-workspace-invalid-preset-"));
    TEMP_DIRS.push(root);
    const target = path.join(root, "project");
    await mkdir(target);

    await expect(service().workspace.create({ ...input(target), esp_presets: ["esp.unknown"] }))
      .rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(service().workspace.create({ ...input(target), esp_presets: ["../../outside"] }))
      .rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(await readdir(target)).toEqual([]);
  });

  it("rejects a non-empty target without changing user files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-workspace-nonempty-"));
    TEMP_DIRS.push(root);
    const target = path.join(root, "project");
    await mkdir(target);
    await writeFile(path.join(target, "notes.txt"), "keep this file\n");

    await expect(service().workspace.create(input(target))).rejects.toMatchObject({ code: "WORKSPACE_NOT_EMPTY" });
    expect(await readdir(target)).toEqual(["notes.txt"]);
    expect(await readFile(path.join(target, "notes.txt"), "utf8")).toBe("keep this file\n");
  });

  it("rolls back only files it created when a template auto block is invalid", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-workspace-rollback-"));
    TEMP_DIRS.push(root);
    const target = path.join(root, "project");
    const templateRoot = path.join(root, "templates", "workspace");
    const skillsRoot = path.join(root, "skills", "demo-skill");
    await Promise.all([
      mkdir(target),
      mkdir(path.join(templateRoot, "_site-index", "skills"), { recursive: true }),
      mkdir(skillsRoot, { recursive: true }),
    ]);
    await writeFile(path.join(skillsRoot, "SKILL.md"), "version: 1.0.0\n", "utf8");
    await writeFile(path.join(templateRoot, "README.md"), "missing auto block markers\n", "utf8");
    const agentBlockIds = ["agents-core", "task-routing", "data-guide", "design-summary", "skills-installed", "esp-presets"];
    const agentTemplate = agentBlockIds.map((id) =>
      '<!-- siteindex:auto:start id="' + id + '" -->\n<!-- siteindex:auto:end id="' + id + '" -->',
    ).join("\n");
    await Promise.all([
      writeFile(path.join(templateRoot, ".gitignore"), ".env\n", "utf8"),
      writeFile(path.join(templateRoot, "AGENTS.md"), agentTemplate, "utf8"),
      writeFile(path.join(templateRoot, "CLAUDE.md"), "@AGENTS.md\n", "utf8"),
      writeFile(
        path.join(templateRoot, "_site-index", "workspace.json"),
        JSON.stringify({ version: "1.0", layout: "workspace", sections: [], paths: {}, esp_presets: [] }),
        "utf8",
      ),
    ]);

    await expect(createWorkspaceFiles(
      { ...input(target), esp_presets: [] },
      { templateDir: path.join(root, "templates", "project") },
    ))
      .rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(await readdir(target)).toEqual([]);
  });
});
