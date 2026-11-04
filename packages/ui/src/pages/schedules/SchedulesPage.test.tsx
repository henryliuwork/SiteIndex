// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import type { ProjectSummary, ScheduleState, SiteIndexError } from "@siteindex/shared";
import { createMockApi } from "../../mock";

afterEach(() => {
  cleanup();
  vi.doUnmock("../../api");
  vi.resetModules();
});

function LocationProbe() {
  return <output data-testid="current-route">{useLocation().pathname}</output>;
}

async function renderSchedules(options: { failScheduleFor?: string } = {}) {
  const mockApi = createMockApi();
  const sourceProjects = await mockApi.projects.list();
  const projects: ProjectSummary[] = sourceProjects.map((project, index) => ({
    ...project,
    id: index === 0 ? "cedar" : "maple",
    name: index === 0 ? "Cedar Shop" : "Maple Shop",
  }));
  const sourceSchedule = await mockApi.schedule.get("demo");
  mockApi.projects.list = vi.fn(async () => projects);
  mockApi.schedule.get = vi.fn(async (id) => {
    if (id === options.failScheduleFor) throw { code: "PROJECT_UNREADABLE", message: "计划文件无法读取。" } satisfies SiteIndexError;
    return { ...sourceSchedule, registered: true } satisfies ScheduleState;
  });
  mockApi.jobs.history = vi.fn(async () => []);

  vi.doMock("../../api", () => ({
    api: mockApi,
    apiErrorDetails: (error: unknown) => typeof error === "object" && error !== null && "message" in error
      ? { message: String(error.message), ...( "code" in error ? { code: String(error.code) } : {}) }
      : null,
    apiErrorMessage: (_error: unknown, fallback: string) => fallback,
  }));
  const { SchedulesPage } = await import("../SchedulesPage");
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={queryClient}><MemoryRouter><SchedulesPage /><LocationProbe /></MemoryRouter></QueryClientProvider>);
  return { mockApi, projects };
}

describe("SchedulesPage", () => {
  it("filters the project list", async () => {
    await renderSchedules();
    expect(await screen.findByRole("row", { name: /Cedar Shop/ })).toBeTruthy();
    expect(screen.getByRole("row", { name: /Maple Shop/ })).toBeTruthy();

    fireEvent.change(screen.getByRole("combobox", { name: "按项目筛选" }), { target: { value: "maple" } });

    expect(screen.getByRole("row", { name: /Maple Shop/ })).toBeTruthy();
    expect(screen.queryByRole("row", { name: /Cedar Shop/ })).toBeNull();
  });

  it("opens the matching project run settings when a row is clicked", async () => {
    await renderSchedules();
    const row = await screen.findByRole("row", { name: /Cedar Shop/ });
    fireEvent.click(row);

    await waitFor(() => expect(screen.getByTestId("current-route").textContent).toBe("/p/cedar/runs"));
  });

  it("keeps a schedule read failure inside its project row", async () => {
    await renderSchedules({ failScheduleFor: "cedar" });

    expect(await screen.findByText("计划读取失败。")).toBeTruthy();
    expect(screen.getByRole("row", { name: /Maple Shop/ })).toBeTruthy();
    expect(await screen.findByText("已注册")).toBeTruthy();
    expect(screen.queryByText("项目列表加载失败。")).toBeNull();
  });
});
