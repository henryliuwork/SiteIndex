import { describe, expect, it } from "vitest";
import { createOverviewMock } from "../overview";
import { createReadmeMock } from "../readme";

describe("data-index focus mock data", () => {
  it("omits the folder map from README automatic blocks", async () => {
    const readme = await createReadmeMock().get("kingsyard");

    expect(readme.auto_blocks.map((block) => block.id)).not.toContain("folder-map");
    expect(readme.folder_map).toEqual([]);
  });

  it("does not report workspace folder descriptions as overview attention", async () => {
    const overview = await createOverviewMock().get("kingsyard");

    expect(overview.attention.some((item) => item.text.includes("_about.md"))).toBe(false);
    expect(overview.attention.some((item) => item.link.includes("settings/folders"))).toBe(false);
  });
});
