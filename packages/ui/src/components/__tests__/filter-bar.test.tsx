import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { calculateFilterBarCollapseHeight, FilterBar } from "../filter-bar";

describe("FilterBar", () => {
  it("keeps up to two rows expanded and clips at the end of row two otherwise", () => {
    expect(calculateFilterBarCollapseHeight([
      { top: 0, height: 32 }, { top: 0, height: 30 }, { top: 40, height: 36 },
    ])).toBeNull();
    expect(calculateFilterBarCollapseHeight([
      { top: 0, height: 32 }, { top: 40, height: 36 }, { top: 40, height: 30 }, { top: 84, height: 32 },
    ])).toBe(76);
  });

  it("renders filter content in a named shared container", () => {
    const markup = renderToStaticMarkup(<FilterBar><button type="button">状态</button></FilterBar>);
    expect(markup).toContain('class="si-filter-bar"');
    expect(markup).toContain('class="si-filter-bar-items"');
  });
});
