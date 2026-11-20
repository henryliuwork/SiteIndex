// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { SideNav } from "../shell";

vi.mock("../update-reminder", () => ({ UpdateReminder: () => null }));
beforeEach(() => vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("SideNav project identity", () => {
  it("shows name and platform/run time in two lines, with domain as hover title", () => {
    render(<MemoryRouter><SideNav projects={[{
      id: "demo", name: "演示项目", domain: "demo.example.test", platform: "magento",
      syncAt: "2026-11-20T08:30:00.000Z", state: "ok",
    }]} /></MemoryRouter>);
    const link = screen.getByRole("link", { name: /演示项目/ });
    expect(link.getAttribute("title")).toBe("demo.example.test");
    expect(link.querySelector(".si-nav-project-name")?.textContent).toBe("演示项目");
    expect(link.querySelector(".si-nav-project-meta")?.textContent).toContain("Magento | ");
    expect(link.querySelector(".si-nav-project-meta")?.textContent).not.toContain("未运行");
  });

  it("keeps unknown platforms and marks a known cloud-sync location", () => {
    render(<MemoryRouter><SideNav projects={[{
      id: "demo", name: "演示项目", platform: "custom-platform", storageLocation: "known_cloud_sync",
    }]} /></MemoryRouter>);
    expect(screen.getByText("custom-platform | 未运行")).toBeTruthy();
    expect(screen.getByRole("img", { name: /第三方同步目录/ })).toBeTruthy();
  });
});
