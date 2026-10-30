import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { configSectionIds, isConfigSectionId, scrollToConfigSection } from "./section-navigation";

describe("项目配置区块导航", () => {
  it("仅接受配置页的十个稳定区块 ID", () => {
    expect(configSectionIds).toHaveLength(10);
    expect(isConfigSectionId("watched-categories")).toBe(true);
    expect(isConfigSectionId("unknown")).toBe(false);
    expect(isConfigSectionId(null)).toBe(false);
  });

  it("将有效目标滚动到视口起点且不依赖 URL hash", () => {
    const scrollIntoView = vi.fn();
    const root = { getElementById: vi.fn(() => ({ scrollIntoView }) as unknown as HTMLElement) };

    expect(scrollToConfigSection("watched-categories", root)).toBe(true);
    expect(root.getElementById).toHaveBeenCalledWith("watched-categories");
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
  });

  it("缺少目标节点时不抛错", () => {
    const root = { getElementById: vi.fn(() => null) };

    expect(scrollToConfigSection("watched-categories", root)).toBe(false);
  });

  it("页面用按钮导航并从路由查询参数处理库存页入口", () => {
    const source = readFileSync(new URL("../ProjectSettingsConfigPage.tsx", import.meta.url), "utf8");
    const inventorySource = readFileSync(new URL("../InventoryPage.tsx", import.meta.url), "utf8");

    expect(source).toContain("useSearchParams");
    expect(source).toContain('searchParams.get("section")');
    expect(source).toContain('type="button" aria-controls={target}');
    expect(source).toContain("scrollToConfigSection(requestedSection)");
    expect(source).not.toContain('href={"#" + target}');
    expect(source).not.toContain("window.location.hash");
    expect(inventorySource).toContain("/settings/config?section=watched-categories");
    expect(inventorySource).not.toContain("/settings/config#watched-categories");
  });
});
