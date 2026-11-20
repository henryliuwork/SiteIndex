// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PageFrame } from "../page-frame";

afterEach(cleanup);

describe("PageFrame", () => {
  it("renders a global header above independently scrolling content", () => {
    const { container } = render(<PageFrame kind="global" header={<h1>设置</h1>}><p>内容</p></PageFrame>);
    const frame = container.querySelector(".si-page-frame-global.is-content");
    expect(frame?.querySelector(".si-page-frame-header h1")?.textContent).toBe("设置");
    expect(frame?.querySelector(".si-page-frame-body p")?.textContent).toBe("内容");
  });

  it("keeps project table pages inside the fixed frame", () => {
    const { container } = render(<PageFrame kind="project" scroll="table" header={<nav>项目导航</nav>}><div>表格</div></PageFrame>);
    expect(container.querySelector(".si-page-frame-project.is-table .si-page-frame-header nav")).not.toBeNull();
    expect(screen.getByText("表格").closest(".si-page-frame-body")).not.toBeNull();
  });
});
