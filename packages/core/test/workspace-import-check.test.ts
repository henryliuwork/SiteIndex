import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathsFor, type WorkspaceCreateInput } from "@siteindex/shared";
import { afterEach, describe, expect, it } from "vitest";
import { createCoreService } from "../src/service";

const TEMP_DIRS: string[] = [];
const paths = pathsFor("workspace");
const manifestRelative = path.posix.join(paths.index, "workspace.json");

function service(projectPath = "") {
  return createCoreService({
    resolveProject: () => projectPath,
    deviceId: "workspace-import-check-test",
    cacheDir: path.join(os.tmpdir(), "siteindex-workspace-import-check-cache"),
  });
}

function createInput(targetDir: string): WorkspaceCreateInput {
  return {
    targetDir,
    domain: "https://demo-import.test",
    brand: { name: "Demo Import", tagline: "Synthetic workspace fixture" },
    platform: "woocommerce",
    markets: ["US"],
    esp_presets: [],
  };
}

function removeAutoBlock(markdown: string, id: string): string {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return markdown.replace(new RegExp('<!-- siteindex:auto:start id="' + escaped + '" -->[\\s\\S]*?<!-- siteindex:auto:end id="' + escaped + '" -->\\r?\\n?', "u"), "");
}

afterEach(async () => {
  await Promise.all(TEMP_DIRS.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("workspace.importCheck", () => {
  it("reports bad formats read-only, then fills only missing files and blocks without replacing user data", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-workspace-import-"));
    TEMP_DIRS.push(root);
    const project = path.join(root, "demo");
    const api = service(project);
    await api.workspace.create(createInput(project));
    expect(await api.workspace.importCheck("demo")).toEqual({ issues: [], repaired: [] });

    const configPath = path.join(project, paths.site);
    const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    delete config.workspace;
    config.operator_note = "Keep existing project metadata.";
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
    const manifestPath = path.join(project, manifestRelative);
    await unlink(manifestPath);
    await unlink(path.join(project, paths.keywords));

    const readmePath = path.join(project, paths.readme);
    const readme = removeAutoBlock(await readFile(readmePath, "utf8"), "workspace-map") + "\n用户补充：保留这段内容。\n";
    await writeFile(readmePath, readme, "utf8");
    const agentsPath = path.join(project, paths.agentsMd);
    const agents = removeAutoBlock(await readFile(agentsPath, "utf8"), "data-guide");
    await writeFile(agentsPath, agents, "utf8");

    const malformedCsvPath = path.join(project, paths.skuTags);
    const malformedCsv = "wrong,headers\nkeep,this row\n";
    await writeFile(malformedCsvPath, malformedCsv, "utf8");
    const malformedJsonlPath = path.join(project, paths.blogIndex);
    const malformedJsonl = "{bad json}\n";
    await writeFile(malformedJsonlPath, malformedJsonl, "utf8");

    const beforeCheck = await api.workspace.importCheck("demo");
    expect(beforeCheck.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: paths.site, code: "workspace_metadata_missing", auto_fixable: false }),
      expect.objectContaining({ path: manifestRelative, code: "workspace_manifest_missing", auto_fixable: true }),
      expect.objectContaining({ path: paths.keywords, code: "missing_ledger", auto_fixable: true }),
      expect.objectContaining({ path: paths.skuTags, code: "header", auto_fixable: false }),
      expect.objectContaining({ path: paths.blogIndex, code: "parse", auto_fixable: false }),
      expect.objectContaining({ path: paths.readme, code: "missing_auto_block:workspace-map", auto_fixable: true }),
      expect.objectContaining({ path: paths.agentsMd, code: "missing_auto_block:data-guide", auto_fixable: true }),
    ]));
    await expect(readFile(path.join(project, paths.validation), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const editedConfig = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    editedConfig.operator_note = "Edited after the read-only report.";
    const configAfterUserEdit = `${JSON.stringify(editedConfig, null, 2)}\n`;
    await writeFile(configPath, configAfterUserEdit, "utf8");
    await writeFile(readmePath, `${await readFile(readmePath, "utf8")}\n用户补充：检查后编辑也要保留。\n`, "utf8");

    const applied = await api.workspace.importCheck("demo", { apply: true });
    expect(applied.repaired).toEqual(expect.arrayContaining([
      manifestRelative, paths.keywords, paths.readme, paths.agentsMd,
    ]));
    expect(applied.repaired).not.toContain(paths.site);
    expect(applied.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: paths.site, code: "workspace_metadata_missing", auto_fixable: false }),
      expect.objectContaining({ path: paths.skuTags, code: "header", auto_fixable: false }),
      expect.objectContaining({ path: paths.blogIndex, code: "parse", auto_fixable: false }),
    ]));
    expect(applied.issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "workspace_manifest_missing" }),
      expect.objectContaining({ path: paths.keywords, code: "missing_ledger" }),
      expect.objectContaining({ code: "missing_auto_block:workspace-map" }),
      expect.objectContaining({ code: "missing_auto_block:data-guide" }),
    ]));
    const metadataIssue = applied.issues.find((issue) => issue.code === "workspace_metadata_missing");
    expect(metadataIssue).toEqual({
      path: paths.site,
      code: "workspace_metadata_missing",
      message: "site.json 缺少 workspace 元数据。为避免覆盖用户配置，请根据 _site-index/workspace.json 手动补充 workspace.version、workspace.sections（目录名数组）和 workspace.esp_presets；若该文件缺失，请先运行自动修复，再重新检查。",
      auto_fixable: false,
    });
    const repairedManifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      version: string;
      sections: { id: string; dir: string }[];
      esp_presets: string[];
    };
    expect(repairedManifest.version).toBe("1.0");
    expect(repairedManifest.sections.map((section) => section.dir)).toContain("01-brand");
    expect(repairedManifest.esp_presets).toEqual(["mailchimp"]);
    expect(await readFile(configPath, "utf8")).toBe(configAfterUserEdit);
    expect(JSON.parse(configAfterUserEdit)).not.toHaveProperty("workspace");
    expect(await readFile(path.join(project, paths.keywords), "utf8")).toBe("");
    expect(await readFile(malformedCsvPath, "utf8")).toBe(malformedCsv);
    expect(await readFile(malformedJsonlPath, "utf8")).toBe(malformedJsonl);
    expect(await readFile(readmePath, "utf8")).toContain("用户补充：保留这段内容。");
    expect(await readFile(readmePath, "utf8")).toContain("用户补充：检查后编辑也要保留。");
    expect(await readFile(readmePath, "utf8")).toContain('id="workspace-map"');
    expect(await readFile(agentsPath, "utf8")).toContain('id="data-guide"');
  }, 30_000);

  it("does not repair a legacy-only project as a workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-workspace-import-legacy-"));
    TEMP_DIRS.push(root);
    const configPath = path.join(root, pathsFor("legacy").site);
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, "{}\n", "utf8");
    const result = await service(root).workspace.importCheck("legacy", { apply: true });
    expect(result.issues).toEqual([
      expect.objectContaining({ path: paths.site, code: "workspace_config_missing", auto_fixable: false }),
    ]);
    expect(result.repaired).toEqual([]);
  });

  it("reports a missing schema_version without rewriting the config", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-workspace-import-schema-"));
    TEMP_DIRS.push(root);
    const project = path.join(root, "demo");
    const api = service(project);
    await api.workspace.create(createInput(project));
    const configPath = path.join(project, paths.site);
    const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    delete config.schema_version;
    const malformed = JSON.stringify(config, null, 2) + "\n";
    await writeFile(configPath, malformed, "utf8");

    const result = await api.workspace.importCheck("demo", { apply: true });
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: paths.site, code: "schema", auto_fixable: false }),
    ]));
    expect(await readFile(configPath, "utf8")).toBe(malformed);
    expect(result.repaired).not.toContain(paths.site);
  }, 30_000);
});
