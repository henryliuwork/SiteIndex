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
    expect(checkedAgain?.invalid_entries).toContain("README.md");
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
});
