import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_WORKSPACE_FOLDERS, PATHS } from "@siteindex/shared";
import { afterEach, describe, expect, it } from "vitest";
import { createCoreService } from "../src/service";

const FIXTURE_PROJECT = path.resolve(process.cwd(), "fixtures/expected/project");
const TEMP_DIRS: string[] = [];

async function makeProject(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-folders-"));
  TEMP_DIRS.push(root);
  const projectPath = path.join(root, "project");
  await cp(FIXTURE_PROJECT, projectPath, { recursive: true });
  return projectPath;
}

function service(projectPath: string) {
  return createCoreService({
    resolveProject: () => projectPath,
    deviceId: "test-device",
    cacheDir: path.join(path.dirname(projectPath), "cache"),
  });
}

afterEach(async () => {
  await Promise.all(TEMP_DIRS.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("core workspace folders", () => {
  it("creates a custom folder, updates site.json and refreshes the README folder map", async () => {
    const projectPath = await makeProject();
    const api = service(projectPath);
    const originalReadme = [
      "# 店铺说明",
      "",
      "## 项目概况",
      "用户维护的概况。",
      "",
      "## 当前重点",
      "本周重点。",
      "",
      "## 工作规则与偏好",
      "保留原始规则。",
      "",
      '<!-- siteindex:auto:start id="folder-map" -->',
      "旧目录地图。",
      '<!-- siteindex:auto:end id="folder-map" -->',
      "",
    ].join("\n");
    await writeFile(path.join(projectPath, PATHS.readme), originalReadme, "utf8");

    const folders = await api.folders.create("fixture", "campaigns", "电子邮件活动工作区");
    const about = await readFile(path.join(projectPath, "campaigns", PATHS.aboutFile), "utf8");
    const config = JSON.parse(await readFile(path.join(projectPath, PATHS.site), "utf8")) as {
      workspace_folders: { name: string; default: boolean }[];
    };
    const readme = await readFile(path.join(projectPath, PATHS.readme), "utf8");

    expect(about).toBe("电子邮件活动工作区\n");
    expect(config.workspace_folders).toEqual([
      ...DEFAULT_WORKSPACE_FOLDERS.map((name) => ({ name, default: true })),
      { name: "campaigns", default: false },
    ]);
    expect(folders.find((folder) => folder.name === "campaigns")).toMatchObject({
      description: "电子邮件活动工作区",
      default: false,
    });
    expect(readme).toContain("用户维护的概况。\n\n## 当前重点\n本周重点。");
    expect(readme).toContain("保留原始规则。");
    expect(readme).toMatch(/<!-- siteindex:auto:start id="folder-map" -->\n## 目录地图[\s\S]*\| `campaigns\/` \| 电子邮件活动工作区 \|[\s\S]*<!-- siteindex:auto:end id="folder-map" -->/);
    expect(readme).not.toContain("旧目录地图。");
  });

  it("changes only the first _about.md paragraph and keeps default folders default", async () => {
    const projectPath = await makeProject();
    const api = service(projectPath);
    await api.folders.create("fixture", "campaigns", "原说明");
    const aboutPath = path.join(projectPath, "campaigns", PATHS.aboutFile);
    await writeFile(aboutPath, "旧说明\n\n## 补充资料\n这部分由用户维护。\n", "utf8");

    const folders = await api.folders.describe("fixture", "CAMPAIGNS", "新的说明\n仍然是同一段");
    const about = await readFile(aboutPath, "utf8");

    expect(about).toBe("新的说明 仍然是同一段\n\n## 补充资料\n这部分由用户维护。\n");
    expect(folders.filter((folder) => (DEFAULT_WORKSPACE_FOLDERS as readonly string[]).includes(folder.name))
      .every((folder) => folder.default)).toBe(true);
    expect(folders.find((folder) => folder.name === "campaigns")?.description).toBe("新的说明 仍然是同一段");
  }, 15_000);

  it("rejects unsafe names, Windows reserved names, duplicates and overlong descriptions", async () => {
    const projectPath = await makeProject();
    const api = service(projectPath);

    await expect(api.folders.create("fixture", "..\\outside", "说明")).rejects.toMatchObject({ code: "UNKNOWN" });
    await expect(api.folders.create("fixture", "CON", "说明")).rejects.toMatchObject({ code: "UNKNOWN" });
    await expect(api.folders.create("fixture", "SEO", "说明")).rejects.toMatchObject({ code: "FOLDER_EXISTS" });
    await expect(api.folders.create("fixture", "notes", "a".repeat(81))).rejects.toMatchObject({ code: "UNKNOWN" });
    await expect(readFile(path.join(path.dirname(projectPath), "outside"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 15_000);
});
