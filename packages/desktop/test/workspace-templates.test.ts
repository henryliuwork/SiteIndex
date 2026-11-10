import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const templateRoot = fileURLToPath(new URL("../../../templates/workspace/", import.meta.url));

async function readTemplate(relativePath: string): Promise<string> {
  return readFile(join(templateRoot, relativePath), "utf8");
}

function autoBlockIds(content: string, kind: "start" | "end"): string[] {
  return [...content.matchAll(new RegExp(`siteindex:auto:${kind} id="([^"]+)"`, "g"))].map((match) => match[1]);
}

describe("workspace template contract", () => {
  it("keeps the README and AGENTS automatic block ids stable", async () => {
    const [readme, agents] = await Promise.all([readTemplate("README.md"), readTemplate("AGENTS.md")]);

    const readmeIds = ["workspace-map", "index-summary", "changelog"];
    const agentsIds = [
      "agents-core",
      "task-routing",
      "data-guide",
      "design-summary",
      "skills-installed",
      "esp-presets",
    ];
    expect(autoBlockIds(readme, "start")).toEqual(readmeIds);
    expect(autoBlockIds(readme, "end")).toEqual(readmeIds);
    expect(autoBlockIds(agents, "start")).toEqual(agentsIds);
    expect(autoBlockIds(agents, "end")).toEqual(agentsIds);
  });

  it("declares the fixed workspace sections and EDM logical paths", async () => {
    const workspace = JSON.parse(await readTemplate("_site-index/workspace.json")) as {
      layout: string;
      sections: Array<{ id: string; dir: string }>;
      paths: Record<string, string>;
      esp_presets: string[];
    };

    expect(workspace.layout).toBe("workspace");
    expect(workspace.sections.map(({ dir }) => dir)).toEqual([
      "01-brand",
      "02-products",
      "03-seo",
      "04-edm",
      "05-affiliate",
      "06-site-updates",
      "07-reports",
    ]);
    expect(workspace.paths["edm.sku_index"]).toBe("_site-index/edm/sku-index.md");
    expect(workspace.paths["edm.profile"]).toBe("_site-index/edm/edm-profile.md");
    expect(workspace.esp_presets).toEqual(["mailchimp"]);
  });

  it("copies workspace templates and skills into the installer resources", async () => {
    const desktopPackage = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      build: { extraResources: Array<{ from: string; to: string }> };
    };
    const prepareResources = await readFile(new URL("../scripts/prepare-resources.mjs", import.meta.url), "utf8");

    expect(desktopPackage.build.extraResources).toEqual(
      expect.arrayContaining([
        { from: "build-resources/templates", to: "templates" },
        { from: "build-resources/skills", to: "skills" },
      ]),
    );
    expect(prepareResources).toContain('for (const directory of ["skills", "templates", "schemas"])');
    await expect(readTemplate("_site-index/workspace.json")).resolves.toBeTruthy();
    await expect(
      readFile(join(fileURLToPath(new URL("../../../skills/", import.meta.url)), "siteindex-data", "SKILL.md"), "utf8"),
    ).resolves.toContain("数据目录");
  });
});
