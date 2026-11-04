// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

async function renderSchedules(options: { failProjectList?: boolean; failScheduleFor?: string; withoutVerify?: boolean; withoutOrphanListing?: boolean; withoutOrphanRemoval?: boolean } = {}) {
  const mockApi = createMockApi();
  const sourceProjects = await mockApi.projects.list();
  const projects: ProjectSummary[] = sourceProjects.map((project, index) => ({
    ...project,
    id: index === 0 ? "cedar" : "maple",
    name: index === 0 ? "Cedar Shop" : "Maple Shop",
  }));
  const sourceSchedule = await mockApi.schedule.get("demo");
  mockApi.projects.list = vi.fn(async () => {
    if (options.failProjectList) throw { code: "UNKNOWN", message: "项目列表无法读取。" } satisfies SiteIndexError;
    return projects;
  });
  mockApi.schedule.get = vi.fn(async (id) => {
    if (id === options.failScheduleFor) throw { code: "PROJECT_UNREADABLE", message: "计划文件无法读取。" } satisfies SiteIndexError;
    return { ...sourceSchedule, registered: true } satisfies ScheduleState;
  });
  const verify = mockApi.schedule.verify;
  const verifySpy = verify ? vi.fn(verify) : undefined;
  if (verifySpy) mockApi.schedule.verify = verifySpy;
  const removeOrphan = mockApi.schedule.removeOrphan;
  const removeOrphanSpy = removeOrphan ? vi.fn(removeOrphan) : undefined;
  if (removeOrphanSpy) mockApi.schedule.removeOrphan = removeOrphanSpy;
  if (options.withoutVerify) delete mockApi.schedule.verify;
  if (options.withoutOrphanListing) delete mockApi.schedule.listOrphans;
  if (options.withoutOrphanRemoval) delete mockApi.schedule.removeOrphan;
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
  return { mockApi, projects, verifySpy, removeOrphanSpy };
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

  it("keeps row controls keyboard-operable without triggering row navigation", async () => {
    await renderSchedules();
    const row = await screen.findByRole("row", { name: /Cedar Shop/ });

    fireEvent.keyDown(within(row).getByRole("button", { name: "校验" }), { key: "Enter" });
    expect(screen.getByTestId("current-route").textContent).toBe("/");

    fireEvent.keyDown(row, { key: "Enter" });
    await waitFor(() => expect(screen.getByTestId("current-route").textContent).toBe("/p/cedar/runs"));
  });

  it("keeps a schedule read failure inside its project row", async () => {
    await renderSchedules({ failScheduleFor: "cedar" });

    expect(await screen.findByText("计划读取失败。")).toBeTruthy();
    expect(screen.getByRole("row", { name: /Maple Shop/ })).toBeTruthy();
    expect(await screen.findByText("已注册")).toBeTruthy();
    expect(screen.queryByText("项目列表加载失败。")).toBeNull();
  });

  it("verifies a schedule path and repairs a mismatch", async () => {
    const { verifySpy } = await renderSchedules();
    const row = await screen.findByRole("row", { name: /Cedar Shop/ });

    fireEvent.click(within(row).getByRole("button", { name: "校验" }));
    expect(await within(row).findByText("路径不一致")).toBeTruthy();

    fireEvent.click(within(row).getByRole("button", { name: "修复" }));
    expect(await within(row).findByText("已注册")).toBeTruthy();
    if (!verifySpy) throw new Error("schedule verification mock is missing");
    expect(verifySpy).toHaveBeenNthCalledWith(1, "cedar", undefined);
    expect(verifySpy).toHaveBeenNthCalledWith(2, "cedar", { repair: true });
  });

  it("lists orphaned system tasks and cleans them up", async () => {
    const { removeOrphanSpy } = await renderSchedules();
    const region = await screen.findByRole("region", { name: "孤立任务" });
    expect(await within(region).findByText("SiteIndex-demo-orphan")).toBeTruthy();

    fireEvent.click(within(region).getByRole("button", { name: "清理" }));

    expect(await within(region).findByText("没有孤立任务。")).toBeTruthy();
    if (!removeOrphanSpy) throw new Error("orphan removal mock is missing");
    expect(removeOrphanSpy).toHaveBeenCalledWith("SiteIndex-demo-orphan");
  });

  it("keeps orphan tasks available when the project list fails", async () => {
    await renderSchedules({ failProjectList: true });

    expect(await screen.findByText("项目列表加载失败。")).toBeTruthy();
    const region = await screen.findByRole("region", { name: "孤立任务" });
    expect(await within(region).findByText("SiteIndex-demo-orphan")).toBeTruthy();
  });

  it("hides verification controls and the orphan section when optional methods are absent", async () => {
    await renderSchedules({ withoutVerify: true, withoutOrphanListing: true });
    const row = await screen.findByRole("row", { name: /Cedar Shop/ });

    expect(within(row).queryByRole("button", { name: "校验" })).toBeNull();
    expect(within(row).queryByRole("button", { name: "修复" })).toBeNull();
    expect(screen.queryByRole("region", { name: "孤立任务" })).toBeNull();
  });

  it("hides the cleanup button when optional orphan removal is unavailable", async () => {
    await renderSchedules({ withoutOrphanRemoval: true });
    const region = await screen.findByRole("region", { name: "孤立任务" });
    expect(await within(region).findByText("SiteIndex-demo-orphan")).toBeTruthy();
    expect(within(region).queryByRole("button", { name: "清理" })).toBeNull();
  });
});
