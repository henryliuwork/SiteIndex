// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import type { ProjectDetail, ProjectSummary, SeoIssue, SiteIndexApi, SiteIndexError } from "@siteindex/shared";
import { createMockApi } from "../mock";

const pendingEmptyWorkspaceHandlers = [
  "projects.createWorkspaceOnly",
  "workspace.check",
];
const pendingImportHandlers = ["workspace.importCheck"];

function mockWorkspaceCapabilities(pendingHandlers: readonly string[]) {
  vi.doMock("./workspace-capabilities", async () => {
    const actual = await vi.importActual<typeof import("./workspace-capabilities")>("./workspace-capabilities");
    return {
      ...actual,
      getWorkspaceCapabilities: (api: SiteIndexApi, isMockApi: boolean) =>
        actual.getWorkspaceCapabilities(api, isMockApi, pendingHandlers),
    };
  });
}

afterEach(() => {
  cleanup();
  vi.doUnmock("../api");
  vi.doUnmock("./workspace-capabilities");
  vi.unstubAllGlobals();
  vi.resetModules();
});

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="current-route">{location.pathname}</output>;
}

async function expectToast(message: string, tone: "success" | "error") {
  await waitFor(() => expect([...document.querySelectorAll(`.si-toast-${tone}`)].some((toast) => toast.textContent?.includes(message))).toBe(true));
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
      isMockApi: true,
      apiErrorMessage: (error: unknown, fallback: string) =>
        typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
          ? error.message
          : fallback,
    }));
    const [{ ProjectCenterPage }, { ToastProvider }] = await Promise.all([import("./ProjectCenterPage"), import("../components/overlays")]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <ToastProvider>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <ProjectCenterPage />
            <LocationProbe />
          </MemoryRouter>
        </QueryClientProvider>
      </ToastProvider>,
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
    await expectToast("已添加项目：Cedar Shop", "success");
    await waitFor(() => expect(verify).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("正在校验系统计划任务…")).toBeTruthy();
    resolveVerification({ state: "path_mismatch", message: "系统任务指向旧路径。" });
    const projectCard = document.querySelector(".si-project-card");
    expect(projectCard).toBeTruthy();
    expect(await within(projectCard as HTMLElement).findByText(/系统计划任务：路径不一致/)).toBeTruthy();
    await waitFor(() => expect(get).toHaveBeenCalledWith("cedar-shop"));
    expect((await mockApi.projects.list())[0]?.path).toBe(projectPath);

    fireEvent.click(await screen.findByRole("button", { name: "打开文件夹" }));
    await waitFor(() => expect(mockApi.shell.openPath).toHaveBeenCalledWith(projectPath));

    fireEvent.click(screen.getByRole("button", { name: "添加已有项目" }));
    fireEvent.change(screen.getByRole("textbox", { name: "项目文件夹路径" }), { target: { value: projectPath } });
    fireEvent.click(screen.getByRole("button", { name: "添加项目" }));

    const addDialog = screen.getByRole("dialog", { name: "添加已有项目" });
    expect(await within(addDialog).findByText("这个项目已经添加。", { selector: ".si-form-error" })).toBeTruthy();
    await expectToast("这个项目已经添加。", "error");
    expect(registered).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(await screen.findAllByRole("link", { name: "Cedar Shop" })).toHaveLength(1);

    fireEvent.click(screen.getByRole("link", { name: "Cedar Shop" }));
    expect(screen.getByTestId("current-route").textContent).toBe("/p/cedar-shop/inventory");
  }, 25_000);
});

describe("ProjectCenterPage attention list", () => {
  async function renderAttentionList(options: { withoutStatus?: boolean; deferStatus?: boolean } = {}) {
    const mockApi = createMockApi();
    const sourceProjects = await mockApi.projects.list();
    const reminders = ["最近提醒 1", "最近提醒 2", "最近提醒 3", "更早的提醒"];
    let attention = reminders.length;
    const projects: ProjectSummary[] = sourceProjects.map((project, index) => index === 0
      ? { ...project, attention, warnings: [] }
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
    mockApi.projects.list = vi.fn(async () => projects.map((project, index) => index === 0 ? { ...project, attention } : project));
    mockApi.jobs.history = vi.fn(async () => []);
    const listIssues = vi.fn(async (_id, query) => {
      const filtered = issueRows.filter((issue) => !query.filters?.status || issue.status === query.filters.status);
      return {
        rows: filtered
        .sort((a, b) => b.last_seen.localeCompare(a.last_seen))
        .slice((query.page - 1) * query.pageSize, query.page * query.pageSize),
        total: filtered.length,
      };
    });
    mockApi.seo.listIssues = listIssues;
    let rejectPending!: (error: SiteIndexError) => void;
    const pendingStatus = new Promise<void>((_resolve, reject) => { rejectPending = reject; });
    const setIssueStatus = vi.fn(async (_id: ProjectSummary["id"], input: { targets: { url: string; rule: SeoIssue["rule"] }[]; status: SeoIssue["status"] }) => {
      if (options.deferStatus) await pendingStatus;
      let updated = 0;
      for (const issue of issueRows) {
        if (!input.targets.some((target) => target.url === issue.url && target.rule === issue.rule) || issue.status === input.status) continue;
        if (issue.status === "open" && input.status !== "open") attention -= 1;
        if (issue.status !== "open" && input.status === "open") attention += 1;
        issue.status = input.status;
        updated += 1;
      }
      return { updated };
    });
    mockApi.seo.setIssueStatus = setIssueStatus;
    if (options.withoutStatus) delete mockApi.seo.setIssueStatus;

    vi.doMock("../api", () => ({
      api: mockApi,
      isMockApi: true,
      apiErrorMessage: (error: unknown, fallback: string) =>
        typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
          ? error.message
          : fallback,
    }));
    const [{ ProjectCenterPage }, { ToastProvider }] = await Promise.all([import("./ProjectCenterPage"), import("../components/overlays")]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(["seo", "summary", sourceProjects[0]!.id], await mockApi.seo.summary(sourceProjects[0]!.id));
    render(
      <ToastProvider>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter><ProjectCenterPage /></MemoryRouter>
        </QueryClientProvider>
      </ToastProvider>,
    );
    return { mockApi, projects, reminders, queryClient, listIssues, setIssueStatus, rejectPending };
  }

  it("expands reminders by project and links to open SEO issues", async () => {
    const { mockApi, projects, reminders } = await renderAttentionList();

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

  it("marks only the selected reminder handled and refreshes the project count and reminder page", async () => {
    const { mockApi, reminders, queryClient, listIssues } = await renderAttentionList();
    fireEvent.click(await screen.findByRole("button", { name: /待处理提醒/ }));
    const panel = screen.getByRole("region", { name: "待处理提醒列表" });
    const row = (await within(panel).findByText(reminders[0]!)).closest("li")!;

    fireEvent.click(within(row).getByRole("button", { name: "已处理" }));

    await waitFor(() => expect(mockApi.seo.setIssueStatus).toHaveBeenCalledWith("demo", {
      targets: [{ url: "https://demo.example.test/page-0", rule: "title_missing" }], status: "fixed",
    }));
    await expectToast("提醒已标记为已处理。", "success");
    expect(await within(panel).findByText(reminders[3]!)).toBeTruthy();
    expect(within(panel).queryByText(reminders[0]!)).toBeNull();
    await waitFor(() => expect(within(screen.getByRole("button", { name: /待处理提醒/ })).getByText("3")).toBeTruthy());
    expect(queryClient.getQueryState(["seo", "summary", "demo"])?.isInvalidated).toBe(true);
    expect(listIssues).toHaveBeenCalledTimes(2);
  });

  it("ignores one reminder through setIssueStatus", async () => {
    const { mockApi, reminders } = await renderAttentionList();
    fireEvent.click(await screen.findByRole("button", { name: /待处理提醒/ }));
    const panel = screen.getByRole("region", { name: "待处理提醒列表" });
    const row = (await within(panel).findByText(reminders[0]!)).closest("li")!;

    fireEvent.click(within(row).getByRole("button", { name: "忽略" }));

    await waitFor(() => expect(mockApi.seo.setIssueStatus).toHaveBeenCalledWith("demo", {
      targets: [{ url: "https://demo.example.test/page-0", rule: "title_missing" }], status: "ignored",
    }));
    await expectToast("提醒已忽略。", "success");
    expect(await within(panel).findByText(reminders[3]!)).toBeTruthy();
    expect(within(panel).queryByText(reminders[0]!)).toBeNull();
  });

  it("shows the API error beside one reminder and disables only that reminder during the request", async () => {
    const { reminders, rejectPending } = await renderAttentionList({ deferStatus: true });
    fireEvent.click(await screen.findByRole("button", { name: /待处理提醒/ }));
    const panel = screen.getByRole("region", { name: "待处理提醒列表" });
    const row = (await within(panel).findByText(reminders[0]!)).closest("li")!;
    const otherRow = (await within(panel).findByText(reminders[1]!)).closest("li")!;

    fireEvent.click(within(row).getByRole("button", { name: "已处理" }));
    await waitFor(() => expect((within(row).getByRole("button", { name: "已处理" }) as HTMLButtonElement).disabled).toBe(true));
    expect((within(otherRow).getByRole("button", { name: "已处理" }) as HTMLButtonElement).disabled).toBe(false);
    rejectPending({ code: "WRITE_FAILED", message: "提醒状态保存失败，请重试。" });

    expect(await within(row).findByRole("alert")).toHaveProperty("textContent", "提醒状态保存失败，请重试。");
    await expectToast("提醒状态保存失败，请重试。", "error");
    expect(within(panel).getByText(reminders[0]!)).toBeTruthy();
  });

  it("hides actions when the optional status method is absent", async () => {
    const { reminders } = await renderAttentionList({ withoutStatus: true });
    fireEvent.click(await screen.findByRole("button", { name: /待处理提醒/ }));
    const panel = screen.getByRole("region", { name: "待处理提醒列表" });
    const row = (await within(panel).findByText(reminders[0]!)).closest("li")!;
    expect(within(row).queryByRole("button", { name: "已处理" })).toBeNull();
    expect(within(row).queryByRole("button", { name: "忽略" })).toBeNull();
  });
});

describe("ProjectCenterPage create empty workspace flow", () => {
  it("creates and opens a workspace-only project when the optional API exists", async () => {
    const mockApi = createMockApi();
    mockApi.jobs.history = vi.fn(async () => []);
    const createWorkspaceOnly = vi.spyOn(mockApi.projects, "createWorkspaceOnly");
    vi.doMock("../api", () => ({
      api: mockApi,
      isMockApi: false,
      apiErrorMessage: (error: unknown, fallback: string) =>
        typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
          ? error.message
          : fallback,
    }));
    mockWorkspaceCapabilities([]);
    const [{ ProjectCenterPage }, { ToastProvider }] = await Promise.all([import("./ProjectCenterPage"), import("../components/overlays")]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <ToastProvider>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <ProjectCenterPage />
            <LocationProbe />
          </MemoryRouter>
        </QueryClientProvider>
      </ToastProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "创建空工作区" }));
    fireEvent.change(screen.getByRole("textbox", { name: "网站地址" }), { target: { value: "empty-workspace.example.test" } });
    fireEvent.change(screen.getByRole("textbox", { name: "品牌名" }), { target: { value: "Empty Workspace" } });
    fireEvent.change(screen.getByRole("textbox", { name: "项目根目录" }), { target: { value: "D:/Projects" } });
    fireEvent.change(screen.getByRole("textbox", { name: "项目文件夹名" }), { target: { value: "empty-workspace" } });
    fireEvent.click(screen.getAllByRole("button", { name: "创建空工作区" }).at(-1)!);

    await waitFor(() => expect(createWorkspaceOnly).toHaveBeenCalledWith(expect.objectContaining({
      url: "https://empty-workspace.example.test",
      projects_root: "D:/Projects",
      folder_name: "empty-workspace",
      workspace: { enabled: true, platform: "other", esp_presets: ["mailchimp"] },
    })));
    await waitFor(() => expect(screen.getByTestId("current-route").textContent).toMatch(/^\/p\/mock-/));
    expect(await screen.findByRole("link", { name: "Empty Workspace" })).toBeTruthy();
    const created = await mockApi.projects.list();
    expect(created.some(({ path }) => path === "D:/Projects/empty-workspace")).toBe(true);
  }, 25_000);

  it("hides the empty workspace action when the optional API is absent", async () => {
    const mockApi = createMockApi();
    delete mockApi.projects.createWorkspaceOnly;
    mockApi.jobs.history = vi.fn(async () => []);
    vi.doMock("../api", () => ({ api: mockApi, isMockApi: true, apiErrorMessage: (_error: unknown, fallback: string) => fallback }));
    const [{ ProjectCenterPage }, { ToastProvider }] = await Promise.all([import("./ProjectCenterPage"), import("../components/overlays")]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<ToastProvider><QueryClientProvider client={queryClient}><MemoryRouter><ProjectCenterPage /></MemoryRouter></QueryClientProvider></ToastProvider>);

    await screen.findByRole("button", { name: "添加已有项目" });
    expect(screen.queryByRole("button", { name: "创建空工作区" })).toBeNull();
  }, 25_000);

  it("hides a Desktop workspace stub while its handler is pending and explains why", async () => {
    const mockApi = createMockApi();
    mockApi.jobs.history = vi.fn(async () => []);
    vi.doMock("../api", () => ({ api: mockApi, isMockApi: false, apiErrorMessage: (_error: unknown, fallback: string) => fallback }));
    mockWorkspaceCapabilities(pendingEmptyWorkspaceHandlers);
    const [{ ProjectCenterPage }, { ToastProvider }] = await Promise.all([import("./ProjectCenterPage"), import("../components/overlays")]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<ToastProvider><QueryClientProvider client={queryClient}><MemoryRouter><ProjectCenterPage /></MemoryRouter></QueryClientProvider></ToastProvider>);

    await screen.findByText("桌面端尚未接入空工作区创建和目录检查操作；现有项目添加与普通新建流程仍可使用。");
    expect(screen.queryByRole("button", { name: "创建空工作区" })).toBeNull();
  }, 25_000);
});

describe("ProjectCenterPage workspace import check", () => {
  it("offers mock repairs and keeps missing site.json workspace metadata as a manual issue", async () => {
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    const mockApi = createMockApi();
    mockApi.jobs.history = vi.fn(async () => []);
    const importCheck = mockApi.workspace?.importCheck;
    if (!importCheck) throw new Error("workspace import-check mock is missing");
    const importCheckSpy = vi.spyOn(mockApi.workspace!, "importCheck");
    vi.doMock("../api", () => ({
      api: mockApi,
      isMockApi: true,
      apiErrorMessage: (error: unknown, fallback: string) =>
        typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
          ? error.message
          : fallback,
    }));
    const [{ ProjectCenterPage }, { ToastProvider }] = await Promise.all([import("./ProjectCenterPage"), import("../components/overlays")]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<ToastProvider><QueryClientProvider client={queryClient}><MemoryRouter><ProjectCenterPage /></MemoryRouter></QueryClientProvider></ToastProvider>);

    fireEvent.click(await screen.findByRole("button", { name: "Demo Catalog更多操作" }));
    fireEvent.click(screen.getByRole("button", { name: "识别并检查工作区" }));
    const dialog = await screen.findByRole("dialog", { name: "识别并检查工作区 · Demo Catalog" });
    expect(await within(dialog).findByText("site.json.workspace 需要手动补充", { exact: false })).toBeTruthy();
    for (const field of ["version", "workspace.version", "sections[].dir", "workspace.sections", "esp_presets", "workspace.esp_presets"]) {
      expect(within(dialog).getByText(field, { exact: true })).toBeTruthy();
    }
    expect(importCheckSpy).toHaveBeenNthCalledWith(1, "demo2", undefined);

    fireEvent.click(within(dialog).getByRole("button", { name: "自动补齐可修复项（2）" }));
    await expectToast("自动补齐请求完成，返回 2 个已补齐路径。", "success");
    expect(within(dialog).getByText("本次已补齐 2 个路径或区块", { exact: true })).toBeTruthy();
    expect(within(dialog).getByText("发现 1 项待处理", { exact: true })).toBeTruthy();
    expect(within(dialog).getByText("需要手动处理", { exact: true })).toBeTruthy();
    expect(importCheckSpy).toHaveBeenNthCalledWith(2, "demo2", { apply: true });
    expect(within(dialog).queryByText("工作区导入检查通过", { exact: true })).toBeNull();

    fireEvent.click(within(dialog).getByRole("button", { name: "重新检查" }));
    await waitFor(() => expect(importCheckSpy).toHaveBeenNthCalledWith(3, "demo2", undefined));
    expect(await within(dialog).findByText("site.json.workspace 需要手动补充", { exact: false })).toBeTruthy();
  }, 25_000);

  it("hides the import-check action while the Desktop handler is pending", async () => {
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    const mockApi = createMockApi();
    mockApi.jobs.history = vi.fn(async () => []);
    vi.doMock("../api", () => ({ api: mockApi, isMockApi: false, apiErrorMessage: (_error: unknown, fallback: string) => fallback }));
    mockWorkspaceCapabilities(pendingImportHandlers);
    const [{ ProjectCenterPage }, { ToastProvider }] = await Promise.all([import("./ProjectCenterPage"), import("../components/overlays")]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<ToastProvider><QueryClientProvider client={queryClient}><MemoryRouter><ProjectCenterPage /></MemoryRouter></QueryClientProvider></ToastProvider>);

    fireEvent.click(await screen.findByRole("button", { name: "Demo Catalog更多操作" }));
    expect(screen.queryByRole("button", { name: "识别并检查工作区" })).toBeNull();
    expect(screen.queryByRole("dialog", { name: /识别并检查工作区/ })).toBeNull();
  });

  it("shows the SiteIndexError message and lets the user retry", async () => {
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    const mockApi = createMockApi();
    mockApi.jobs.history = vi.fn(async () => []);
    const importCheck = mockApi.workspace?.importCheck;
    if (!importCheck) throw new Error("workspace import-check mock is missing");
    const importCheckSpy = vi.fn(importCheck);
    importCheckSpy.mockRejectedValueOnce({ code: "PROJECT_UNREADABLE", message: "无法读取工作区数据目录。" });
    mockApi.workspace!.importCheck = importCheckSpy;
    vi.doMock("../api", () => ({
      api: mockApi,
      isMockApi: true,
      apiErrorMessage: (error: unknown, fallback: string) =>
        typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
          ? error.message
          : fallback,
    }));
    const [{ ProjectCenterPage }, { ToastProvider }] = await Promise.all([import("./ProjectCenterPage"), import("../components/overlays")]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<ToastProvider><QueryClientProvider client={queryClient}><MemoryRouter><ProjectCenterPage /></MemoryRouter></QueryClientProvider></ToastProvider>);

    fireEvent.click(await screen.findByRole("button", { name: "Demo Catalog更多操作" }));
    fireEvent.click(screen.getByRole("button", { name: "识别并检查工作区" }));
    const dialog = await screen.findByRole("dialog", { name: "识别并检查工作区 · Demo Catalog" });
    expect(await within(dialog).findByText("无法读取工作区数据目录。", { exact: true })).toBeTruthy();
    await expectToast("无法读取工作区数据目录。", "error");
    fireEvent.click(within(dialog).getByRole("button", { name: "重新检查" }));
    await waitFor(() => expect(importCheckSpy).toHaveBeenCalledTimes(2));
    expect(await within(dialog).findByText("site.json.workspace 需要手动补充", { exact: false })).toBeTruthy();
  }, 25_000);

  it("recognizes a legacy project and does not offer workspace repairs", async () => {
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    const mockApi = createMockApi();
    mockApi.jobs.history = vi.fn(async () => []);
    vi.doMock("../api", () => ({ api: mockApi, isMockApi: true, apiErrorMessage: (_error: unknown, fallback: string) => fallback }));
    const [{ ProjectCenterPage }, { ToastProvider }] = await Promise.all([import("./ProjectCenterPage"), import("../components/overlays")]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<ToastProvider><QueryClientProvider client={queryClient}><MemoryRouter><ProjectCenterPage /></MemoryRouter></QueryClientProvider></ToastProvider>);

    fireEvent.click(await screen.findByRole("button", { name: "Demo Store更多操作" }));
    fireEvent.click(screen.getByRole("button", { name: "识别并检查工作区" }));
    const dialog = await screen.findByRole("dialog", { name: "识别并检查工作区 · Demo Store" });
    expect(await within(dialog).findByText("未识别为 Agent 工作区", { exact: true })).toBeTruthy();
    expect(within(dialog).getByText("此项目没有找到工作区数据目录；本次没有修改项目文件。")).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: /自动补齐/ })).toBeNull();
  }, 25_000);
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
      isMockApi: true,
      apiErrorMessage: (error: unknown, fallback: string) =>
        typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
          ? error.message
          : fallback,
    }));
    const [{ ProjectCenterPage }, { ToastProvider }] = await Promise.all([import("./ProjectCenterPage"), import("../components/overlays")]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<ToastProvider><QueryClientProvider client={queryClient}><MemoryRouter><ProjectCenterPage /></MemoryRouter></QueryClientProvider></ToastProvider>);

    fireEvent.click(await screen.findByRole("button", { name: "Demo Catalog更多操作" }));
    fireEvent.click(screen.getByRole("button", { name: "移除项目" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("仅取消登记，不会删除项目文件夹里的任何文件；同时会注销这个项目的系统计划任务。")).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "移除项目" }));

    await waitFor(() => expect(removeSpy).toHaveBeenCalledWith("demo2"));
    await waitFor(() => expect(screen.queryByRole("link", { name: "Demo Catalog" })).toBeNull());
    expect((await mockApi.projects.get("demo2")).summary.path).toBeTruthy();
  });

  it("keeps import check available while hiding project removal when its method is absent", async () => {
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    const mockApi = createMockApi();
    delete mockApi.projects.remove;
    mockApi.jobs.history = vi.fn(async () => []);
    vi.doMock("../api", () => ({
      api: mockApi,
      isMockApi: true,
      apiErrorMessage: (error: unknown, fallback: string) =>
        typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
          ? error.message
          : fallback,
    }));
    const [{ ProjectCenterPage }, { ToastProvider }] = await Promise.all([import("./ProjectCenterPage"), import("../components/overlays")]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<ToastProvider><QueryClientProvider client={queryClient}><MemoryRouter><ProjectCenterPage /></MemoryRouter></QueryClientProvider></ToastProvider>);

    await screen.findByRole("link", { name: "Demo Catalog" });
    fireEvent.click(screen.getByRole("button", { name: "Demo Catalog更多操作" }));
    expect(screen.getByRole("button", { name: "识别并检查工作区" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "移除项目" })).toBeNull();
  }, 25_000);
});
