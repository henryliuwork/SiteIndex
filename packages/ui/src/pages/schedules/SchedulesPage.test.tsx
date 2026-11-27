// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import type { ProjectSummary, RunLog, ScheduleState, SiteIndexError } from "@siteindex/shared";
import { createMockApi } from "../../mock";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.doUnmock("../../api");
  vi.resetModules();
});

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400);
  vi.stubGlobal("ResizeObserver", class {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element): void {
      this.callback([{ target, contentRect: { width: 800, height: 400 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    unobserve(): void {}
    disconnect(): void {}
  });
  localStorage.clear();
});

function LocationProbe() {
  return <output data-testid="current-route">{useLocation().pathname}</output>;
}

async function expectToast(message: string, tone: "success" | "error") {
  await waitFor(() => expect([...document.querySelectorAll(`.si-toast-${tone}`)].some((toast) => toast.textContent?.includes(message))).toBe(true));
}

async function renderSchedules(options: { failProjectList?: boolean; failScheduleFor?: string; failVerify?: boolean; withoutVerify?: boolean; withoutOrphanListing?: boolean; withoutOrphanRemoval?: boolean; withoutSystemTasks?: boolean; reverseProjects?: boolean } = {}) {
  const mockApi = createMockApi();
  const sourceProjects = await mockApi.projects.list();
  const projects: ProjectSummary[] = sourceProjects.map((project, index) => ({
    ...project,
    id: index === 0 ? "cedar" : "maple",
    name: index === 0 ? "Cedar Shop" : "Maple Shop",
  }));
  if (options.reverseProjects) projects.reverse();
  const sourceSchedule = await mockApi.schedule.get("demo");
  mockApi.projects.list = vi.fn(async () => {
    if (options.failProjectList) throw { code: "UNKNOWN", message: "项目列表无法读取。" } satisfies SiteIndexError;
    return projects;
  });
  mockApi.schedule.get = vi.fn(async (id) => {
    if (id === options.failScheduleFor) throw { code: "PROJECT_UNREADABLE", message: "计划文件无法读取。" } satisfies SiteIndexError;
    return {
      ...sourceSchedule,
      config: {
        ...sourceSchedule.config,
        daily: { ...sourceSchedule.config.daily, time: id === "cedar" ? "03:00" : "02:00" },
        weekly: { ...sourceSchedule.config.weekly, time: id === "cedar" ? "04:00" : "01:00" },
      },
      registered: id === "cedar",
      next_runs: [{ job: "daily", at: id === "cedar" ? "2026-10-24T03:00:00Z" : "2026-10-23T02:00:00Z" }],
    } satisfies ScheduleState;
  });
  const verify = mockApi.schedule.verify;
  const verifySpy = verify ? vi.fn(verify) : undefined;
  if (verifySpy && options.failVerify) verifySpy.mockRejectedValue({ code: "UNKNOWN", message: "校验调用失败。" } satisfies SiteIndexError);
  if (verifySpy) mockApi.schedule.verify = verifySpy;
  const removeOrphan = mockApi.schedule.removeOrphan;
  const removeOrphanSpy = removeOrphan ? vi.fn(removeOrphan) : undefined;
  if (removeOrphanSpy) mockApi.schedule.removeOrphan = removeOrphanSpy;
  const listSystemTasks = mockApi.schedule.listSystemTasks;
  const listSystemTasksSpy = listSystemTasks ? vi.fn(listSystemTasks) : undefined;
  if (listSystemTasksSpy) mockApi.schedule.listSystemTasks = listSystemTasksSpy;
  if (options.withoutVerify) delete mockApi.schedule.verify;
  if (options.withoutOrphanListing) delete mockApi.schedule.listOrphans;
  if (options.withoutOrphanRemoval) delete mockApi.schedule.removeOrphan;
  if (options.withoutSystemTasks) delete mockApi.schedule.listSystemTasks;
  mockApi.jobs.history = vi.fn(async (id) => [{
    run_id: `${id}-daily`, job: "daily", trigger: "schedule", status: "ok",
    started_at: id === "cedar" ? "2026-10-22T03:00:00Z" : "2026-10-21T02:00:00Z",
    finished_at: id === "cedar" ? "2026-10-22T03:01:00Z" : "2026-10-21T02:01:00Z",
  } satisfies RunLog]);

  vi.doMock("../../api", () => ({
    api: mockApi,
    apiErrorDetails: (error: unknown) => typeof error === "object" && error !== null && "message" in error
      ? { message: String(error.message), ...( "code" in error ? { code: String(error.code) } : {}) }
      : null,
    apiErrorMessage: (_error: unknown, fallback: string) => fallback,
  }));
  const [{ SchedulesPage }, { ToastProvider }] = await Promise.all([import("../SchedulesPage"), import("../../components/overlays")]);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<ToastProvider><QueryClientProvider client={queryClient}><MemoryRouter><SchedulesPage /><LocationProbe /></MemoryRouter></QueryClientProvider></ToastProvider>);
  return { mockApi, projects, verifySpy, removeOrphanSpy, listSystemTasksSpy };
}

describe("SchedulesPage", () => {
  it.each([
    ["项目", "Cedar Shop"], ["每日同步", "Maple Shop"], ["每周抓取", "Maple Shop"],
    ["系统计划任务", "Maple Shop"], ["最近一次运行", "Maple Shop"], ["下一次运行", "Maple Shop"],
  ])("sorts %s before pagination and restores the default order on the third click", async (column, firstAscending) => {
    await renderSchedules({ reverseProjects: column === "项目" });
    const firstDataRow = () => screen.getAllByRole("row").slice(1)[0];
    await waitFor(() => {
      expect(screen.getAllByRole("row").slice(1)).toHaveLength(2);
      expect(screen.queryAllByText("正在读取…")).toHaveLength(0);
    });
    const defaultFirst = column === "项目" ? "Maple Shop" : "Cedar Shop";
    expect(firstDataRow()?.textContent).toContain(defaultFirst);
    expect(firstAscending).not.toBe(defaultFirst);

    const header = within(screen.getByRole("columnheader", { name: column })).getByRole("button");
    fireEvent.click(header);
    expect(header.closest("th")?.getAttribute("aria-sort")).toBe("ascending");
    await waitFor(() => expect(firstDataRow()?.textContent).toContain(firstAscending));

    fireEvent.click(header);
    expect(header.closest("th")?.getAttribute("aria-sort")).toBe("descending");
    await waitFor(() => expect(firstDataRow()?.textContent).toContain(firstAscending === "Cedar Shop" ? "Maple Shop" : "Cedar Shop"));

    fireEvent.click(header);
    expect(header.closest("th")?.getAttribute("aria-sort")).toBe("none");
    await waitFor(() => expect(firstDataRow()?.textContent).toContain(defaultFirst));
  });

  it("filters the project list", async () => {
    await renderSchedules();
    expect(await screen.findByRole("row", { name: /Cedar Shop/ })).toBeTruthy();
    expect(screen.getByRole("row", { name: /Maple Shop/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("combobox", { name: "按项目筛选" }));
    fireEvent.click(await screen.findByRole("option", { name: "Maple Shop" }));

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
    const verifyButton = within(row).getByRole("button", { name: "校验" });
    expect(verifyButton.closest("td")?.classList.contains("is-sticky-right")).toBe(true);

    fireEvent.keyDown(verifyButton, { key: "Enter" });
    expect(screen.getByTestId("current-route").textContent).toBe("/");

    fireEvent.keyDown(row, { key: "Enter" });
    await waitFor(() => expect(screen.getByTestId("current-route").textContent).toBe("/p/cedar/runs"));
  });

  it("keeps a schedule read failure inside its project row", async () => {
    await renderSchedules({ failScheduleFor: "cedar" });

    expect(await screen.findByText("计划读取失败。")).toBeTruthy();
    expect(screen.getByRole("row", { name: /Maple Shop/ })).toBeTruthy();
    expect(await screen.findByText("未注册")).toBeTruthy();
    expect(screen.queryByText("项目列表加载失败。")).toBeNull();
  });

  it("verifies a schedule path and repairs a mismatch", async () => {
    const { verifySpy } = await renderSchedules();
    const row = await screen.findByRole("row", { name: /Cedar Shop/ });

    fireEvent.click(within(row).getByRole("button", { name: "校验" }));
    if (!verifySpy) throw new Error("schedule verification mock is missing");
    await waitFor(() => expect(verifySpy).toHaveBeenNthCalledWith(1, "cedar", undefined));
    await expect(verifySpy.mock.results[0]!.value).resolves.toMatchObject({ state: "path_mismatch" });
    const mismatch = await screen.findByText("路径不一致");
    expect(mismatch).toBeTruthy();

    const mismatchRow = await screen.findByRole("row", { name: /Cedar Shop/ });
    const repairButton = within(mismatchRow).getByRole("button", { name: "修复" });
    expect(repairButton.closest("td")?.classList.contains("is-sticky-right")).toBe(true);
    fireEvent.click(repairButton);
    expect(await within(mismatchRow).findByText("系统计划任务路径已修复。")).toBeTruthy();
    await expectToast("系统计划任务已修复。", "success");
    expect(verifySpy).toHaveBeenNthCalledWith(1, "cedar", undefined);
    expect(verifySpy).toHaveBeenNthCalledWith(2, "cedar", { repair: true });
  }, 15_000);

  it("lists orphaned system tasks and cleans them up", async () => {
    const { removeOrphanSpy } = await renderSchedules();
    fireEvent.click(screen.getByRole("button", { name: /^孤立任务$/ }));
    const region = await screen.findByRole("region", { name: "孤立任务" });
    expect(await within(region).findByText("SiteIndex-demo-orphan")).toBeTruthy();

    fireEvent.click(within(region).getByRole("button", { name: "清理" }));

    expect(await within(region).findByText("没有孤立任务")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^系统计划任务$/, expanded: false }));
    const systemTaskRegion = await screen.findByRole("region", { name: "系统计划任务" });
    await waitFor(() => expect(within(systemTaskRegion).queryByText("SiteIndex-demo-orphan")).toBeNull());
    if (!removeOrphanSpy) throw new Error("orphan removal mock is missing");
    expect(removeOrphanSpy).toHaveBeenCalledWith("SiteIndex-demo-orphan");
    await expectToast("孤立计划任务已清理。", "success");
  });

  it("keeps orphan tasks available when the project list fails", async () => {
    await renderSchedules({ failProjectList: true });

    expect(await screen.findByText("项目列表加载失败。")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^孤立任务$/ }));
    const region = await screen.findByRole("region", { name: "孤立任务" });
    expect(await within(region).findByText("SiteIndex-demo-orphan")).toBeTruthy();
  });

  it("hides verification controls and the orphan section when optional methods are absent", async () => {
    await renderSchedules({ withoutVerify: true, withoutOrphanListing: true, withoutSystemTasks: true });
    const row = await screen.findByRole("row", { name: /Cedar Shop/ });

    expect(within(row).queryByRole("button", { name: "校验" })).toBeNull();
    expect(within(row).queryByRole("button", { name: "修复" })).toBeNull();
    expect(screen.queryByRole("region", { name: "孤立任务" })).toBeNull();
    expect(screen.queryByRole("region", { name: "系统计划任务" })).toBeNull();
  });

  it("shows read-only system task state, next run, configuration differences, and refresh", async () => {
    const { listSystemTasksSpy } = await renderSchedules();
    const toggle = screen.getByRole("button", { name: /^系统计划任务$/, expanded: false });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBe("si-schedule-system-panel");
    toggle.focus();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(toggle);
    const region = await screen.findByRole("region", { name: "系统计划任务" });

    expect(await within(region).findByText("SiteIndex-demo-daily")).toBeTruthy();
    expect(within(region).getByText("就绪")).toBeTruthy();
    expect(within(region).getByText("与配置不一致")).toBeTruthy();
    expect(within(region).getByText("触发时间：系统 02:30，项目配置 02:00。")).toBeTruthy();
    expect(within(region).getAllByText(/下次运行：/).length).toBeGreaterThan(0);
    if (!listSystemTasksSpy) throw new Error("system task mock is missing");

    fireEvent.click(within(region).getByRole("button", { name: "刷新" }));
    await waitFor(() => expect(listSystemTasksSpy).toHaveBeenCalledTimes(2));
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("region", { name: "系统计划任务" })).toBeNull();
  });

  it("hides the cleanup button when optional orphan removal is unavailable", async () => {
    await renderSchedules({ withoutOrphanRemoval: true });
    fireEvent.click(screen.getByRole("button", { name: /^孤立任务$/ }));
    const region = await screen.findByRole("region", { name: "孤立任务" });
    expect(await within(region).findByText("SiteIndex-demo-orphan")).toBeTruthy();
    expect(within(region).queryByRole("button", { name: "清理" })).toBeNull();
  });

  it("shows a Toast when schedule verification fails", async () => {
    await renderSchedules({ failVerify: true });
    const row = await screen.findByRole("row", { name: /Cedar Shop/ });
    fireEvent.click(within(row).getByRole("button", { name: "校验" }));

    await expectToast("计划任务校验失败。", "error");
  });
});
