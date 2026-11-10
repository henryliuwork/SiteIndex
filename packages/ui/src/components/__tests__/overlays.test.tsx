// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button } from "../primitives";
import { Drawer, ToastProvider, useToast } from "../overlays";

function DrawerHarness() {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" onClick={() => setOpen(true)}>打开详情</button>
    <Drawer open={open} onOpenChange={setOpen} title="库存详情" description="查看当前库存信息" footer={<Button>关闭</Button>}>库存内容</Drawer>
  </>;
}

function ToastHarness() {
  const toast = useToast();
  return <>
    <Button onClick={() => toast.success("已保存")}>保存</Button>
    <Button onClick={() => toast.error("保存失败")}>触发错误</Button>
  </>;
}

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "siteindexWindow");
  vi.useRealTimers();
});

function installTitleBarBridge(setTitleBarOverlayColor: (color: string) => void): void {
  Object.defineProperty(window, "siteindexWindow", {
    configurable: true,
    value: { setTitleBarOverlayColor },
  });
}

function MultipleDrawerHarness() {
  const [firstOpen, setFirstOpen] = useState(false);
  const [secondOpen, setSecondOpen] = useState(false);
  return <>
    <button type="button" onClick={() => { setFirstOpen(true); setSecondOpen(true); }}>同时打开两个</button>
    <Drawer open={firstOpen} onOpenChange={setFirstOpen} title="第一个抽屉">第一个内容</Drawer>
    <Drawer open={secondOpen} onOpenChange={setSecondOpen} title="第二个抽屉">第二个内容</Drawer>
  </>;
}

describe("Drawer and Toast", () => {
  it("closes with Escape and returns focus to the opener", async () => {
    render(<DrawerHarness />);
    const opener = screen.getByRole("button", { name: "打开详情" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole("dialog", { name: "库存详情" });
    expect(dialog.getAttribute("aria-describedby")).toBeTruthy();
    expect(dialog.textContent).toContain("库存内容");
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

  it("tints the native title bar while a Drawer is open and restores white after close", async () => {
    const setTitleBarOverlayColor = vi.fn();
    installTitleBarBridge(setTitleBarOverlayColor);
    render(<DrawerHarness />);

    fireEvent.click(screen.getByRole("button", { name: "打开详情" }));
    await waitFor(() => expect(setTitleBarOverlayColor).toHaveBeenLastCalledWith("#BCBEBD"));
    fireEvent.click(screen.getByRole("button", { name: "关闭抽屉" }));
    await waitFor(() => expect(setTitleBarOverlayColor).toHaveBeenLastCalledWith("#FFFFFF"));
  });

  it("keeps the tint until the final Drawer closes and clears it when an open Drawer unmounts", async () => {
    const setTitleBarOverlayColor = vi.fn();
    installTitleBarBridge(setTitleBarOverlayColor);
    const view = render(<MultipleDrawerHarness />);

    fireEvent.click(screen.getByRole("button", { name: "同时打开两个" }));
    expect(setTitleBarOverlayColor).toHaveBeenNthCalledWith(1, "#BCBEBD");
    expect(setTitleBarOverlayColor).toHaveBeenNthCalledWith(2, "#8C8F8D");
    // Radix 把非顶层 modal 隐藏在可访问树外；测试直接触发其中一个抽屉的关闭回调。
    const closeButtons = screen.getAllByRole("button", { name: "关闭抽屉", hidden: true });
    fireEvent.click(closeButtons[1]!);
    expect(setTitleBarOverlayColor).toHaveBeenLastCalledWith("#BCBEBD");
    view.unmount();
    expect(setTitleBarOverlayColor).toHaveBeenLastCalledWith("#FFFFFF");
  });

  it("degrades safely when the Desktop bridge is missing or throws", () => {
    const { unmount } = render(<DrawerHarness />);
    fireEvent.click(screen.getByRole("button", { name: "打开详情" }));
    unmount();

    const setTitleBarOverlayColor = vi.fn(() => { throw new Error("bridge unavailable"); });
    installTitleBarBridge(setTitleBarOverlayColor);
    const secondView = render(<DrawerHarness />);
    fireEvent.click(screen.getByRole("button", { name: "打开详情" }));
    expect(screen.getByRole("dialog", { name: "库存详情" })).toBeTruthy();
    secondView.unmount();
  });

  it("auto-dismisses success messages after three seconds", async () => {
    vi.useFakeTimers();
    render(<ToastProvider><ToastHarness /></ToastProvider>);
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(screen.getByRole("status").textContent).toContain("已保存");
    await act(async () => { vi.advanceTimersByTime(3000); });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("keeps errors until manually dismissed", async () => {
    vi.useFakeTimers();
    render(<ToastProvider><ToastHarness /></ToastProvider>);
    fireEvent.click(screen.getByRole("button", { name: "触发错误" }));
    expect(screen.getByRole("alert").textContent).toContain("保存失败");
    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(screen.getByRole("alert").textContent).toContain("保存失败");
    fireEvent.click(screen.getByRole("button", { name: "关闭通知" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
