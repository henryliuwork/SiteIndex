import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TabPanel, Tabs } from "../primitives";

describe("tab and tabpanel relationships", () => {
  it("links only the selected tab to the currently rendered panel", () => {
    const markup = renderToStaticMarkup(<Tabs
      value="inventory"
      options={[{ value: "overview", label: "概览" }, { value: "inventory", label: "库存" }]}
      onChange={() => undefined}
      ariaLabel="项目页面"
      tabIdPrefix="project-tab-kingsyard"
      panelIdPrefix="project-panel-kingsyard"
    />);

    expect(markup).toContain('id="project-tab-kingsyard-overview"');
    expect(markup).toContain('id="project-tab-kingsyard-inventory"');
    expect(markup).not.toContain('aria-controls="project-panel-kingsyard-overview"');
    expect(markup).toContain('aria-controls="project-panel-kingsyard-inventory"');
    expect(markup).toContain('aria-selected="true" tabindex="0"');
    expect(markup).toContain('aria-selected="false" tabindex="-1"');
  });

  it("renders the matching tabpanel attributes", () => {
    const markup = renderToStaticMarkup(<TabPanel id="project-panel-kingsyard-inventory" labelledBy="project-tab-kingsyard-inventory">SKU 表格</TabPanel>);

    expect(markup).toContain('id="project-panel-kingsyard-inventory"');
    expect(markup).toContain('role="tabpanel"');
    expect(markup).toContain('aria-labelledby="project-tab-kingsyard-inventory"');
    expect(markup).toContain('tabindex="0"');
  });
});
