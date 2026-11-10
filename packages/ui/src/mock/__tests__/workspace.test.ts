import { describe, expect, it } from "vitest";
import { createMockApi } from "..";

describe("workspace mock", () => {
  it("checks an empty target, creates the template tree, then reports its files as occupied", async () => {
    const api = createMockApi();
    const targetDir = "C:/SiteIndex/Projects/agent-demo";
    expect(await api.workspace?.check(targetDir)).toEqual({ ok: true, invalid_entries: [] });

    const created = await api.workspace?.create({
      targetDir,
      domain: "demo.example.test",
      brand: { name: "Demo Brand" },
      platform: "shopify",
      markets: ["US"],
      esp_presets: ["mailchimp"],
    });

    expect(created?.path).toBe(targetDir);
    expect(created?.created).toContain("AGENTS.md");
    expect(created?.created).toContain("_site-index/skills/presets/esp.mailchimp.md");
    const checkedAgain = await api.workspace?.check(targetDir);
    expect(checkedAgain?.ok).toBe(false);
    expect(checkedAgain?.invalid_entries).toContain(".env");
  });

  it("registers a project after creating an empty workspace without running initialization jobs", async () => {
    const api = createMockApi();
    const target = "D:/Projects/Empty Demo";
    const created = await api.projects.createWorkspaceOnly?.({
      url: "https://empty.example.test",
      brand: { name: "Empty Demo" },
      markets: ["US"],
      projects_root: "D:/Projects",
      folder_name: "Empty Demo",
      workspace: { enabled: true, platform: "shopify", esp_presets: ["mailchimp"] },
    });

    expect(created?.id).toBeTruthy();
    const listed = (await api.projects.list()).find(({ id }) => id === created?.id);
    expect(listed?.name).toBe("Empty Demo");
    expect(listed?.path).toBe(target);
    expect(listed?.sync.state).toBe("never");
    expect(await api.workspace?.check(target)).toMatchObject({ ok: false });
  });

  it("matches Core error codes and messages for invalid and occupied targets", async () => {
    const api = createMockApi();
    await expect(api.workspace?.check("")).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      message: "工作区目录无效，请选择一个项目文件夹。",
    });

    const input = {
      targetDir: "C:/SiteIndex/Projects/occupied",
      domain: "demo.example.test",
      brand: { name: "Demo Brand" },
      platform: "shopify" as const,
      markets: ["US"],
      esp_presets: ["mailchimp"],
    };
    await api.workspace?.create(input);
    await expect(api.workspace?.create(input)).rejects.toMatchObject({
      code: "WORKSPACE_NOT_EMPTY",
      message: "目标目录不是空目录。请改选空目录；未覆盖任何已有内容。",
      detail: expect.stringContaining("AGENTS.md"),
    });
  });

  it("simulates import auto-repair while keeping missing site.json workspace metadata manual", async () => {
    const api = createMockApi();
    const importCheck = api.workspace?.importCheck;
    if (!importCheck) throw new Error("workspace import-check mock is missing");

    const initial = await importCheck("demo2");
    expect(initial.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "_site-index/workspace.json", code: "workspace_manifest_missing", auto_fixable: true }),
      expect.objectContaining({ path: "_site-index/ledgers/sku_media.csv", code: "missing_ledger", auto_fixable: true }),
      expect.objectContaining({ path: "_site-index/site.json", code: "workspace_metadata_missing", auto_fixable: false }),
    ]));

    const applied = await importCheck("demo2", { apply: true });
    expect(applied.repaired).toEqual(["_site-index/ledgers/sku_media.csv", "_site-index/workspace.json"]);
    expect(applied.issues).toHaveLength(1);
    expect(applied.issues[0]).toMatchObject({ code: "workspace_metadata_missing", auto_fixable: false });
    expect(applied.issues[0]?.message).toContain("workspace.version、workspace.sections");

    const checkedAgain = await importCheck("demo2");
    expect(checkedAgain.repaired).toEqual([]);
    expect(checkedAgain.issues.map(({ code }) => code)).toEqual(["workspace_metadata_missing"]);
  });

  it("recognizes a project without the workspace site config and makes no repair", async () => {
    const api = createMockApi();
    const result = await api.workspace?.importCheck?.("demo");
    expect(result).toEqual({
      issues: [{
        path: "_site-index/site.json",
        code: "workspace_config_missing",
        message: "找不到工作区数据目录中的 site.json。",
        auto_fixable: false,
      }],
      repaired: [],
    });
  });
});
