// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TableSection } from "../table-section";

afterEach(cleanup);

describe("TableSection", () => {
  it("keeps summary, selected filters, and table in the shared order", () => {
    const { container } = render(<TableSection summary={<span>摘要</span>} selectedFilters={<button>已选筛选</button>}><div className="si-data-table">表格</div></TableSection>);
    expect(Array.from(container.querySelector(".si-table-section")!.children, (child) => child.className)).toEqual([
      "si-table-section-summary", "si-table-section-selected-filters", "si-data-table",
    ]);
  });

  it("does not reserve a filter row when none is selected", () => {
    const { container } = render(<TableSection><div className="si-data-table">表格</div></TableSection>);
    expect(container.querySelector(".si-table-section-selected-filters")).toBeNull();
    expect(container.querySelector(".si-table-section")?.children).toHaveLength(1);
  });
});
