// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { InfoTooltip } from "../info-tooltip";

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});
afterAll(() => vi.unstubAllGlobals());
afterEach(cleanup);

describe("InfoTooltip", () => {
  it("uses an accessible icon button and opens on keyboard focus", async () => {
    render(<InfoTooltip label="库存口径说明" content="只统计可售商品。" />);
    const trigger = screen.getByRole("button", { name: "库存口径说明" });
    fireEvent.focus(trigger);
    expect((await screen.findByRole("tooltip")).textContent).toContain("只统计可售商品。");
  });

  it("opens on hover and closes on Escape", async () => {
    render(<InfoTooltip label="计划说明" content="每天执行一次。" />);
    const trigger = screen.getByRole("button", { name: "计划说明" });
    fireEvent.pointerMove(trigger, { pointerType: "mouse" });
    expect((await screen.findByRole("tooltip")).textContent).toContain("每天执行一次。");
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  });
});
