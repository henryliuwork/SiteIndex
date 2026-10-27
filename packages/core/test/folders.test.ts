import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PATHS, type SiteConfig } from "@siteindex/shared";
import { afterEach, describe, expect, it } from "vitest";
import { createCoreService } from "../src/service";

const FIXTURE_PROJECT = path.resolve(process.cwd(), "fixtures/expected/project");
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("legacy workspace folders", () => {
  it("ignores old configuration, preserves user files and removes the field on write", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-legacy-folders-"));
    tempDirs.push(root);
    const projectPath = path.join(root, "project");
    await cp(FIXTURE_PROJECT, projectPath, { recursive: true });
    const configPath = path.join(projectPath, PATHS.site);
    const config = JSON.parse(await readFile(configPath, "utf8")) as SiteConfig;
    config.workspace_folders = [{ name: "campaigns", default: false }];
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
    const folderPath = path.join(projectPath, "campaigns");
    await mkdir(folderPath);
    const aboutPath = path.join(folderPath, PATHS.aboutFile);
    const about = "用户原有的说明\n\n其他内容不能改。\n";
    await writeFile(aboutPath, about);
    const readmePath = path.join(projectPath, PATHS.readme);
    const readme = `# 项目\n\n<!-- siteindex:auto:start id="folder-map" -->\n用户原有的目录地图\n<!-- siteindex:auto:end id="folder-map" -->\n`;
    await writeFile(readmePath, readme);

    const api = createCoreService({ resolveProject: () => projectPath, deviceId: "test-device", cacheDir: path.join(root, "cache") });
    expect((await api.projects.get("fixture")).config.workspace_folders).toEqual([]);
    expect((await api.folders.list("fixture"))).toEqual([]);
    expect((await api.folders.create("fixture", "new-folder", "new"))).toEqual([]);
    expect((await api.folders.describe("fixture", "campaigns", "new"))).toEqual([]);
    expect((await api.readme.get("fixture")).folder_map).toEqual([]);
    expect((await api.overview.get("fixture")).attention.map((item) => item.text).join(" ")).not.toContain("文件夹说明");
    await api.readme.refresh("fixture");
    expect(await readFile(readmePath, "utf8")).toContain("用户原有的目录地图\n<!-- siteindex:auto:end id=\"folder-map\" -->");

    await api.projects.updateConfig("fixture", { workspace_folders: [{ name: "ignored", default: false }], locale: "en-GB" });
    const saved = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    expect(saved).not.toHaveProperty("workspace_folders");
    expect(saved.locale).toBe("en-GB");
    await api.schedule.save("fixture", (await api.schedule.get("fixture")).config);
    expect(JSON.parse(await readFile(configPath, "utf8"))).not.toHaveProperty("workspace_folders");
    expect(await readFile(aboutPath, "utf8")).toBe(about);
    await expect(readFile(path.join(projectPath, "new-folder", PATHS.aboutFile))).rejects.toMatchObject({ code: "ENOENT" });

    await writeFile(readmePath, '# 项目\n\n<!-- siteindex:auto:start id="folder-map" -->\n旧内容\n');
    const validation = await api.files.validate("fixture");
    expect(validation.files.find((file) => file.path === PATHS.readme)?.rule).not.toBe("readme_markers");
    await api.readme.refresh("fixture");
    expect(await readFile(readmePath, "utf8")).toContain('<!-- siteindex:auto:start id="folder-map" -->\n旧内容\n');

    const oldConfig = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    oldConfig.workspace_folders = "legacy malformed value";
    await writeFile(configPath, JSON.stringify(oldConfig, null, 2) + "\n");
    const legacyValidation = await api.files.validate("fixture", PATHS.site);
    expect(legacyValidation.files.find((file) => file.path === PATHS.site)?.status).toBe("ok");
    await api.files.repair("fixture", PATHS.site, "autofix");
    expect(JSON.parse(await readFile(configPath, "utf8"))).not.toHaveProperty("workspace_folders");
  }, 30_000);
});
