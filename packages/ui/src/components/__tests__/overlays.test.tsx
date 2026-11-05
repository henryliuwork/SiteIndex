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
  vi.useRealTimers();
});

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
