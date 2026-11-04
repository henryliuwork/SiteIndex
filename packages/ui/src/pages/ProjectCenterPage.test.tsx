// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import type { ProjectDetail, ProjectSummary, SeoIssue, SiteIndexError } from "@siteindex/shared";
import { createMockApi } from "../mock";

afterEach(() => {
  cleanup();
  vi.doUnmock("../api");
  vi.unstubAllGlobals();
  vi.resetModules();
});

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="current-route">{location.pathname}</output>;
}

describe("ProjectCenterPage add existing project flow", () => {
  it("adds a project, refreshes the center, opens its path, navigates by ID, and reports duplicates", async () => {
    const mockApi = createMockApi();
    const openPath = vi.spyOn(mockApi.shell, "openPath");
    const sourceDetail = await mockApi.projects.get("riverstone");
    const projectPath = "D:\\SiteIndex\\Cedar Shop";
    const project: ProjectSummary = {
      ...sourceDetail.summary,
      id: "cedar-shop",
      name: "Cedar Shop",
      domain: "cedar.example.test",
      path: projectPath,
      warnings: ["需要检查项目文件"],
    };
    const registered: ProjectSummary[] = [];
    const list = vi.fn(async () => [...registered]);
    const get = vi.fn(async (id: string): Promise<ProjectDetail> => ({
      ...sourceDetail,
      summary: registered.find((item) => item.id === id) ?? { ...project, id },
    }));
    const addExisting = vi.fn(async (path: string): Promise<ProjectSummary> => {
      const trimmedPath = path.trim();
      if (registered.some((item) => item.path.toLocaleLowerCase() === trimmedPath.toLocaleLowerCase())) {
        throw { code: "FOLDER_EXISTS", message: "这个项目已经添加。" } satisfies SiteIndexError;
      }
      const added = { ...project, path: trimmedPath };
      registered.push(added);
      return added;
    });
    let resolveVerification!: (value: { state: "path_mismatch"; message: string }) => void;
    const pendingVerification = new Promise<{ state: "path_mismatch"; message: string }>((resolve) => { resolveVerification = resolve; });
    const verify = vi.fn(async () => pendingVerification);
    let resolvePendingAdd!: (value: ProjectSummary) => void;
    const pendingAdd = new Promise<ProjectSummary>((resolve) => { resolvePendingAdd = resolve; });
    addExisting.mockImplementationOnce(() => pendingAdd);
    mockApi.projects.list = list;
    mockApi.projects.get = get;
    mockApi.projects.addExisting = addExisting;
    mockApi.schedule.verify = verify;
    mockApi.jobs.history = vi.fn(async () => []);

    vi.doMock("../api", () => ({
      api: mockApi,
      apiErrorMessage: (error: unknown, fallback: string) =>
        typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
          ? error.message
          : fallback,
    }));
    const { ProjectCenterPage } = await import("./ProjectCenterPage");
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ProjectCenterPage />
          <LocationProbe />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "添加已有项目" }));
    const pathInput = screen.getByRole("textbox", { name: "项目文件夹路径" });
    fireEvent.change(pathInput, { target: { value: ` ${projectPath} ` } });
    fireEvent.click(screen.getByRole("button", { name: "添加项目" }));
    expect(await screen.findByText("正在读取项目…", { exact: true })).toBeTruthy();
    expect((pathInput as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "读取中…" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "取消" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(pathInput.closest("form")!);
    expect(addExisting).toHaveBeenCalledTimes(1);
    const addedProject = { ...project, path: projectPath };
    registered.push(addedProject);
    resolvePendingAdd(addedProject);

    const projectLink = await screen.findByRole("link", { name: "Cedar Shop" });
    expect(projectLink.getAttribute("href")).toBe("/p/cedar-shop/inventory");
    expect(addExisting).toHaveBeenNthCalledWith(1, projectPath);
    await waitFor(() => expect(verify).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("正在校验系统计划任务…")).toBeTruthy();
    resolveVerification({ state: "path_mismatch", message: "系统任务指向旧路径。" });
    expect(await screen.findByText(/系统计划任务：路径不一致/)).toBeTruthy();
    await waitFor(() => expect(get).toHaveBeenCalledWith("cedar-shop"));
    expect((await mockApi.projects.list())[0]?.path).toBe(projectPath);

    fireEvent.click(await screen.findByRole("button", { name: "打开文件夹" }));
    await waitFor(() => expect(mockApi.shell.openPath).toHaveBeenCalledWith(projectPath));

    fireEvent.click(screen.getByRole("button", { name: "添加已有项目" }));
    fireEvent.change(screen.getByRole("textbox", { name: "项目文件夹路径" }), { target: { value: projectPath } });
    fireEvent.click(screen.getByRole("button", { name: "添加项目" }));

    expect((await screen.findByRole("alert")).textContent).toContain("这个项目已经添加。");
    expect(registered).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(await screen.findAllByRole("link", { name: "Cedar Shop" })).toHaveLength(1);

    fireEvent.click(screen.getByRole("link", { name: "Cedar Shop" }));
    expect(screen.getByTestId("current-route").textContent).toBe("/p/cedar-shop/inventory");
  }, 25_000);
});

describe("ProjectCenterPage attention list", () => {
  it("expands reminders by project and links to open SEO issues", async () => {
    const mockApi = createMockApi();
    const sourceProjects = await mockApi.projects.list();
    const reminders = ["最近提醒 1", "最近提醒 2", "最近提醒 3", "更早的提醒"];
    const projects: ProjectSummary[] = sourceProjects.map((project, index) => index === 0
      ? { ...project, attention: 4, warnings: [] }
      : { ...project, attention: 0, warnings: [] });
    const issueRows: SeoIssue[] = reminders.map((detail, index) => ({
      url: "https://demo.example.test/page-" + index,
      rule: "title_missing",
      severity: "high",
      detail,
      status: "open",
      first_seen: "2026-11-01",
      last_seen: "2026-11-0" + (4 - index),
    }));
    mockApi.projects.list = vi.fn(async () => projects);
    mockApi.jobs.history = vi.fn(async () => []);
    mockApi.seo.listIssues = vi.fn(async (_id, query) => ({
      rows: issueRows.filter((issue) => !query.filters?.status || issue.status === query.filters.status)
        .sort((a, b) => b.last_seen.localeCompare(a.last_seen))
        .slice((query.page - 1) * query.pageSize, query.page * query.pageSize),
      total: issueRows.length,
    }));

    vi.doMock("../api", () => ({
      api: mockApi,
      apiErrorMessage: (error: unknown, fallback: string) =>
        typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
          ? error.message
          : fallback,
    }));
    const { ProjectCenterPage } = await import("./ProjectCenterPage");
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter><ProjectCenterPage /></MemoryRouter>
      </QueryClientProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: /待处理提醒/ }));
    const panel = screen.getByRole("region", { name: "待处理提醒列表" });
    await within(panel).findByText("最近提醒 1");
    expect(within(panel).getByText(projects[0]!.name)).toBeTruthy();
    expect(within(panel).getByText("4 条待处理")).toBeTruthy();
    for (const message of reminders.slice(0, 3)) expect(within(panel).getByText(message)).toBeTruthy();
    expect(within(panel).queryByText("更早的提醒")).toBeNull();
    expect(mockApi.seo.listIssues).toHaveBeenCalledWith(projects[0]!.id, {
      page: 1, pageSize: 3, sort: { field: "last_seen", dir: "desc" }, filters: { status: "open" },
    });
    expect(within(panel).getByRole("link", { name: "去处理" }).getAttribute("href"))
      .toBe("/p/" + projects[0]!.id + "/seo?status=open");
  });
});

describe("ProjectCenterPage project removal", () => {
  it("confirms unregistering without deleting files and refreshes the center", async () => {
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    const mockApi = createMockApi();
    const remove = mockApi.projects.remove;
    if (!remove) throw new Error("project removal mock is missing");
    const removeSpy = vi.fn(remove);
    mockApi.projects.remove = removeSpy;
    mockApi.jobs.history = vi.fn(async () => []);
    vi.doMock("../api", () => ({
      api: mockApi,
      apiErrorMessage: (error: unknown, fallback: string) =>
        typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
          ? error.message
          : fallback,
    }));
    const { ProjectCenterPage } = await import("./ProjectCenterPage");
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><MemoryRouter><ProjectCenterPage /></MemoryRouter></QueryClientProvider>);

    fireEvent.click(await screen.findByRole("button", { name: "Demo Catalog更多操作" }));
    fireEvent.click(screen.getByRole("button", { name: "移除项目" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("仅取消登记，不会删除项目文件夹里的任何文件；同时会注销这个项目的系统计划任务。")).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "移除项目" }));

    await waitFor(() => expect(removeSpy).toHaveBeenCalledWith("demo2"));
    await waitFor(() => expect(screen.queryByRole("link", { name: "Demo Catalog" })).toBeNull());
    expect((await mockApi.projects.get("demo2")).summary.path).toBeTruthy();
  });

  it("hides the more menu when the optional remove method is unavailable", async () => {
    const mockApi = createMockApi();
    delete mockApi.projects.remove;
    mockApi.jobs.history = vi.fn(async () => []);
    vi.doMock("../api", () => ({
      api: mockApi,
      apiErrorMessage: (error: unknown, fallback: string) =>
        typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
          ? error.message
          : fallback,
    }));
    const { ProjectCenterPage } = await import("./ProjectCenterPage");
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><MemoryRouter><ProjectCenterPage /></MemoryRouter></QueryClientProvider>);

    await screen.findByRole("link", { name: "Demo Catalog" });
    expect(screen.queryByRole("button", { name: "Demo Catalog更多操作" })).toBeNull();
  });
});
