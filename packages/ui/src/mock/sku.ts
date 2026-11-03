import type { SiteIndexApi, SkuGroupingPreview, SkuGroupingRule } from "@siteindex/shared";
import { reply } from "./context";
import { recommendedSkuGroupingPattern, trailingNumberPattern } from "../pages/project-settings-config/sku-grouping-presets";

const groupingPreview: SkuGroupingPreview = {
  parents: 2,
  children: 4,
  unmatched: 1,
  samples: [
    { parent: "DEMO001A", children: ["DEMO001A01", "DEMO001A02"] },
    { parent: "DEMO003A", children: ["DEMO003A01", "DEMO003A02"] },
  ],
  collisions: [
    { parent: "DEMO002A", children: ["DEMO002A01", "DEMO002A02"] },
  ],
};

const trailingNumberPreview: SkuGroupingPreview = {
  parents: 3,
  children: 4,
  unmatched: 1,
  samples: [
    { parent: "DEMO", children: ["DEMO001"] },
    { parent: "DEMO001CP", children: ["DEMO001CP01"] },
    { parent: "DEMO003A", children: ["DEMO003A01", "DEMO003A02"] },
  ],
  collisions: groupingPreview.collisions,
};

const recommendedPreview: SkuGroupingPreview = {
  parents: 2,
  children: 3,
  unmatched: 2,
  samples: [
    { parent: "DEMO001CP", children: ["DEMO001CP01"] },
    { parent: "DEMO003A", children: ["DEMO003A01", "DEMO003A02"] },
  ],
  collisions: groupingPreview.collisions,
};

function previewForRule(rule: SkuGroupingRule): SkuGroupingPreview {
  if (rule.type !== "regex") return groupingPreview;
  if (rule.value === trailingNumberPattern) return trailingNumberPreview;
  if (rule.value === recommendedSkuGroupingPattern) return recommendedPreview;
  return groupingPreview;
}

export function createSkuMock(): NonNullable<SiteIndexApi["sku"]> {
  return {
    previewGrouping: (_projectId, rule) => reply(() => previewForRule(rule)),
  };
}
