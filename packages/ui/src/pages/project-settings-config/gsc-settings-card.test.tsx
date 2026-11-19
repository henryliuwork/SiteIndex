// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { GscSettingsCard } from "./gsc-settings-card";

afterEach(cleanup);

describe("GSC 项目设置", () => {
  it("仅显示一行未开放状态，不提供连接和同步操作", () => {
    render(<GscSettingsCard />);
    const card = screen.getByRole("region", { name: "Google Search Console" });
    expect(card.textContent).toBe("Google Search Console暂未开放");
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
  });
});
