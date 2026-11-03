import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { calculateFilterBarCollapseHeight, FilterBar } from "../filter-bar";

describe("FilterBar", () => {
  it("treats vertically overlapping labels and chips as one row", () => {
    expect(calculateFilterBarCollapseHeight([
      { top: 6, height: 17 }, { top: 0, height: 30 }, { top: 7, height: 17 },
    ])).toBeNull();
  });

  it("keeps one or two rows expanded and clips at the maximum bottom of row two otherwise", () => {
    expect(calculateFilterBarCollapseHeight([
      { top: 6, height: 17 }, { top: 0, height: 30 },
    ])).toBeNull();
    expect(calculateFilterBarCollapseHeight([
      { top: 6, height: 17 }, { top: 0, height: 30 },
      { top: 46, height: 17 }, { top: 40, height: 30 },
    ])).toBeNull();
    expect(calculateFilterBarCollapseHeight([
      { top: 46, height: 17 }, { top: 0, height: 30 },
      { top: 40, height: 30 }, { top: 6, height: 17 },
      { top: 80, height: 30 },
    ])).toBe(70);
  });

  it("renders filter content in a named shared container", () => {
    const markup = renderToStaticMarkup(<FilterBar><button type="button">状态</button></FilterBar>);
    expect(markup).toContain('class="si-filter-bar"');
    expect(markup).toContain('class="si-filter-bar-items"');
  });
});
