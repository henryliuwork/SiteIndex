import { describe, expect, it } from "vitest";
import { createEdmMock } from "./edm";
import { createSeoMock } from "./seo";

describe("T7 mock sort fixtures", () => {
  it("provides distinct manual EDM image URLs that reverse under sorting", async () => {
    const api = createEdmMock();
    const [ascending, descending] = await Promise.all([
      api.listImages("demo", { page: 1, pageSize: 0, sort: { field: "manual_image_url", dir: "asc" } }),
      api.listImages("demo", { page: 1, pageSize: 0, sort: { field: "manual_image_url", dir: "desc" } }),
    ]);
    const ascSkus = ascending.rows.filter((row) => row.manual_image_url).map((row) => row.sku);
    const descSkus = descending.rows.filter((row) => row.manual_image_url).map((row) => row.sku);

    expect(new Set(ascSkus).size).toBeGreaterThanOrEqual(4);
    expect(descSkus).toEqual([...ascSkus].reverse());
  });

  it("provides distinct SEO issue-change dates that reverse under sorting", async () => {
    const api = createSeoMock();
    const [ascending, descending] = await Promise.all([
      api.listPageRows!("demo", { page: 1, pageSize: 0, sort: { field: "last_issue_change_date", dir: "asc" } }),
      api.listPageRows!("demo", { page: 1, pageSize: 0, sort: { field: "last_issue_change_date", dir: "desc" } }),
    ]);
    const ascUrls = ascending.rows.filter((row) => row.last_issue_change_date).map((row) => row.url);
    const descUrls = descending.rows.filter((row) => row.last_issue_change_date).map((row) => row.url);

    expect(new Set(ascending.rows.flatMap((row) => row.last_issue_change_date ? [row.last_issue_change_date] : [])).size).toBeGreaterThanOrEqual(5);
    expect(descUrls).toEqual([...ascUrls].reverse());
  });
});
