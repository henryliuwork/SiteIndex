// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import type { ProjectDetail, ProjectSummary, SiteIndexError } from "@siteindex/shared";
import { createMockApi } from "../mock";

afterEach(cleanup);

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
    let resolvePendingAdd!: (value: ProjectSummary) => void;
    const pendingAdd = new Promise<ProjectSummary>((resolve) => { resolvePendingAdd = resolve; });
    addExisting.mockImplementationOnce(() => pendingAdd);
    mockApi.projects.list = list;
    mockApi.projects.get = get;
    mockApi.projects.addExisting = addExisting;
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
