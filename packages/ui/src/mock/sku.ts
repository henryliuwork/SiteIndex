import type { SiteIndexApi, SkuGroupingPreview } from "@siteindex/shared";
import { reply } from "./context";

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

export function createSkuMock(): NonNullable<SiteIndexApi["sku"]> {
  return {
    previewGrouping: () => reply(groupingPreview),
  };
}
