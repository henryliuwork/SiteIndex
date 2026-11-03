import { describe, expect, it } from "vitest";
import { createSkuMock } from "../sku";
import { recommendedSkuGroupingPattern, trailingNumberPattern } from "../../pages/project-settings-config/sku-grouping-presets";

describe("SKU 分组预览 mock", () => {
  it("用 DEMO001 和 DEMO001CP01 展示两个预设的预览差异", async () => {
    const mock = createSkuMock();
    const legacy = await mock.previewGrouping("demo", { type: "regex", value: trailingNumberPattern });
    const recommended = await mock.previewGrouping("demo", { type: "regex", value: recommendedSkuGroupingPattern });

    expect(legacy.samples).toContainEqual({ parent: "DEMO", children: ["DEMO001"] });
    expect(legacy.samples).toContainEqual({ parent: "DEMO001CP", children: ["DEMO001CP01"] });
    expect(recommended.samples).not.toContainEqual({ parent: "DEMO", children: ["DEMO001"] });
    expect(recommended.samples).toContainEqual({ parent: "DEMO001CP", children: ["DEMO001CP01"] });
    expect(legacy.parents).toBeGreaterThan(recommended.parents);
    expect(legacy.unmatched).toBeLessThan(recommended.unmatched);
  });
});
