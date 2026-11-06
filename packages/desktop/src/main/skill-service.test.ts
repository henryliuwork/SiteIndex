import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectId, SkillPlatform } from "@siteindex/shared";
import { createSkillService, type SkillProject } from "./skill-service.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeSkill(sourceDirectory: string, name: string, version: string, body = "\n# Example\n") {
  const directory = path.join(sourceDirectory, name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "SKILL.md"),
    `---\nname: ${name}\nversion: ${version}\ndescription: Skill ${name}\nreads:\n  - README.md\nwrites: []\n---\n${body}`,
    "utf8",
  );
}

function skillService(
  sourceDirectory: string,
  homeDirectory: string,
  projects: SkillProject[],
  platforms: SkillPlatform[] = [],
) {
  return createSkillService({
    sourceDirectory,
    homeDirectory,
    listProjects: async () => projects,
    getPlatforms: async () => platforms,
  });
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("desktop skill service", () => {
  it("reads the bundled skill metadata and exposes the CLI fallback instructions", async () => {
    const service = skillService(
      path.resolve(process.cwd(), "skills"),
      await temporaryDirectory("siteindex-skill-home-"),
      [],
    );
    const skills = await service.list();
    expect(skills).toHaveLength(10);
    expect(skills.every((skill) => skill.reads.length > 0)).toBe(true);
    expect(skills.find((skill) => skill.name === "siteindex-data")?.version).toBe("1.1.0");
    for (const name of ["siteindex-edm-plan", "siteindex-edm-build", "siteindex-edm-mc-send"]) {
      expect(skills.find((skill) => skill.name === name)?.version).toBe("1.0.0");
    }
    expect(skills.find((skill) => skill.name === "stock-report")?.writes).toEqual([]);
    expect(skills.some((skill) => skill.name === "edm-builder")).toBe(false);
    await expect(service.get("edm-builder")).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    const data = await service.get("siteindex-data");
    expect(data.body).toContain("UTF-8 无 BOM、LF 换行");
    expect(data.body).toContain("不得编造 SKU、价格、库存状态或数量、图片 URL");
  });

  it("installs a project skill, updates its manifest, and reports stale versions", async () => {
    const root = await temporaryDirectory("siteindex-skill-project-");
    const sourceDirectory = path.join(root, "bundled");
    const projectPath = path.join(root, "project");
    const homeDirectory = path.join(root, "home");
    await writeSkill(sourceDirectory, "blog-writer", "1.1.0");
    await writeSkill(path.join(projectPath, "_agent", "skills"), "blog-writer", "1.0.0");
    const project = { id: "sample-store" as ProjectId, path: projectPath };
    const service = skillService(sourceDirectory, homeDirectory, [project]);

    await expect(service.list()).resolves.toMatchObject([{ name: "blog-writer", has_update: true }]);
    await expect(service.targets("blog-writer")).resolves.toContainEqual(
      expect.objectContaining({ target_id: "project:sample-store", status: "outdated" }),
    );

    await expect(service.install("blog-writer", "project:sample-store")).resolves.toMatchObject({
      target_id: "project:sample-store",
      status: "latest",
    });
    const installedContent = await readFile(
      path.join(projectPath, "_agent", "skills", "blog-writer", "SKILL.md"),
      "utf8",
    );
    expect(installedContent).toContain("version: 1.1.0");
    await expect(
      readFile(path.join(projectPath, "_agent", "skills", "manifest.json"), "utf8").then((value) => JSON.parse(value)),
    ).resolves.toEqual({ version: 1, skills: { "blog-writer": "1.1.0" } });
    await expect(service.get("blog-writer")).resolves.toMatchObject({ info: { has_update: false } });
  });

  it("installs to Codex and syncs every bundled skill into every project", async () => {
    const root = await temporaryDirectory("siteindex-skill-sync-");
    const sourceDirectory = path.join(root, "bundled");
    const homeDirectory = path.join(root, "home");
    const firstProject = { id: "first" as ProjectId, path: path.join(root, "first") };
    const secondProject = { id: "second" as ProjectId, path: path.join(root, "second") };
    const customPlatform: SkillPlatform = {
      id: "qwenpaw",
      name: "QwenPaw",
      dir: "~/.qwenpaw/skills",
      detected: false,
    };
    await writeSkill(sourceDirectory, "blog-writer", "1.0.0");
    await writeSkill(sourceDirectory, "stock-report", "1.0.0");
    const service = skillService(sourceDirectory, homeDirectory, [firstProject, secondProject], [customPlatform]);

    await expect(service.install("blog-writer", "codex")).resolves.toMatchObject({ status: "latest" });
    await expect(service.install("blog-writer", "agents-dir")).resolves.toMatchObject({
      target_id: "agents-dir",
      status: "latest",
    });
    await expect(service.install("blog-writer", "qwenpaw")).resolves.toMatchObject({ status: "latest" });
    await expect(
      readFile(path.join(homeDirectory, ".codex", "skills", "blog-writer", "SKILL.md"), "utf8"),
    ).resolves.toContain("name: blog-writer");
    await expect(
      readFile(path.join(homeDirectory, ".qwenpaw", "skills", "blog-writer", "SKILL.md"), "utf8"),
    ).resolves.toContain("name: blog-writer");
    await expect(
      readFile(path.join(homeDirectory, ".agents", "skills", "blog-writer", "SKILL.md"), "utf8"),
    ).resolves.toContain("name: blog-writer");
    await service.syncAllProjects();
    for (const project of [firstProject, secondProject]) {
      await expect(
        readFile(path.join(project.path, "_agent", "skills", "stock-report", "SKILL.md"), "utf8"),
      ).resolves.toContain("name: stock-report");
      const manifest = JSON.parse(
        await readFile(path.join(project.path, "_agent", "skills", "manifest.json"), "utf8"),
      ) as {
        version: number;
        skills: Record<string, string>;
      };
      expect(manifest.skills).toEqual({ "blog-writer": "1.0.0", "stock-report": "1.0.0" });
    }
  });

  it("rejects unknown skills and unconfigured install targets", async () => {
    const root = await temporaryDirectory("siteindex-skill-invalid-");
    const sourceDirectory = path.join(root, "bundled");
    await writeSkill(sourceDirectory, "blog-writer", "1.0.0");
    const service = skillService(sourceDirectory, path.join(root, "home"), []);

    await expect(service.get("../blog-writer")).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(service.install("blog-writer", "missing-target")).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("keeps newer local copies and reports their version without overwriting them", async () => {
    const root = await temporaryDirectory("siteindex-skill-newer-");
    const sourceDirectory = path.join(root, "bundled");
    const projectPath = path.join(root, "project");
    await writeSkill(sourceDirectory, "blog-writer", "1.1.0");
    await writeSkill(path.join(projectPath, "_agent", "skills"), "blog-writer", "2.0.0", "\n# User copy\n");
    const service = skillService(
      sourceDirectory,
      path.join(root, "home"),
      [{ id: "sample-store" as ProjectId, path: projectPath }],
    );

    await service.syncAllProjects();

    await expect(
      readFile(path.join(projectPath, "_agent", "skills", "blog-writer", "SKILL.md"), "utf8"),
    ).resolves.toContain("# User copy");
    await expect(service.targets("blog-writer")).resolves.toContainEqual(
      expect.objectContaining({ target_id: "project:sample-store", status: "latest", local_newer: true }),
    );
  });

  it("shows installed edm-builder copies as retired without deleting or reinstalling them", async () => {
    const root = await temporaryDirectory("siteindex-skill-retired-");
    const sourceDirectory = path.join(root, "bundled");
    const homeDirectory = path.join(root, "home");
    const installedPath = path.join(homeDirectory, ".agents", "skills", "edm-builder", "SKILL.md");
    await writeSkill(sourceDirectory, "siteindex-edm-plan", "1.0.0");
    await writeSkill(path.join(homeDirectory, ".agents", "skills"), "edm-builder", "1.1.0", "\n# Local copy\n");
    const service = skillService(sourceDirectory, homeDirectory, []);
    const original = await readFile(installedPath, "utf8");

    await expect(service.list()).resolves.toContainEqual(expect.objectContaining({ name: "edm-builder", retired: true }));
    await expect(service.get("edm-builder")).resolves.toMatchObject({
      info: { name: "edm-builder", retired: true },
      body: expect.stringContaining("已退役"),
    });
    await expect(service.targets("edm-builder")).resolves.toContainEqual(
      expect.objectContaining({ target_id: "agents-dir", retired: true }),
    );
    await expect(service.install("edm-builder", "agents-dir")).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await service.syncAllProjects();
    await expect(readFile(installedPath, "utf8")).resolves.toBe(original);
  });
});
