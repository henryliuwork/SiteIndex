// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button } from "../primitives";
import { Card, EmptyState, Notice, PageHeader } from "../layout-primitives";

afterEach(cleanup);

describe("shared layout components", () => {
  it("provides a labeled card region", () => {
    render(<Card label="库存摘要"><span>在售 12</span></Card>);
    expect(screen.getByRole("region", { name: "库存摘要" }).textContent).toContain("在售 12");
  });

  it("shows Notice as an accessible alert and keeps its action reachable", () => {
    const onRetry = vi.fn();
    render(<Notice tone="error" title="读取失败" action={<Button onClick={onRetry}>重试</Button>}>请稍后再试。</Notice>);
    expect(screen.getByRole("alert").textContent).toContain("请稍后再试。");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("explains an empty state and exposes its next action", () => {
    render(<EmptyState title="暂无项目" action={<Button>添加已有项目</Button>}>项目列表为空。</EmptyState>);
    expect(screen.getByRole("status").textContent).toContain("项目列表为空。");
    expect(screen.getByRole("button", { name: "添加已有项目" })).toBeTruthy();
  });

  it("opens PageHeader overflow actions and invokes the selected action", async () => {
    const onSelect = vi.fn();
    render(<PageHeader
      title="项目列表"
      meta="最近同步于今天"
      actions={<Button variant="primary">新建项目</Button>}
      overflow={[{ label: "刷新", onSelect }]}
    />);
    expect(screen.getByRole("heading", { name: "项目列表", level: 1 })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    const item = await screen.findByRole("menuitem", { name: "刷新" });
    expect(document.activeElement).toBe(item);
    fireEvent.click(item);
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it("supports arrow-key navigation in the overflow menu", async () => {
    render(<PageHeader title="产品" overflow={[
      { label: "刷新", onSelect: vi.fn() },
      { label: "导出", onSelect: vi.fn() },
    ]} />);
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    const refresh = await screen.findByRole("menuitem", { name: "刷新" });
    const exportItem = screen.getByRole("menuitem", { name: "导出" });
    expect(document.activeElement).toBe(refresh);
    fireEvent.keyDown(refresh, { key: "ArrowDown" });
    expect(document.activeElement).toBe(exportItem);
    fireEvent.keyDown(exportItem, { key: "Home" });
    expect(document.activeElement).toBe(refresh);
  });
});
