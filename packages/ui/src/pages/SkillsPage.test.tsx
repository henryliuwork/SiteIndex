// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { createMockApi } from "../mock";

afterEach(() => {
  cleanup();
  vi.doUnmock("../api");
  vi.resetModules();
});

describe("SkillsPage skill catalog", () => {
  it("lists the manual image Skill and keeps media writes out of sku-media-enrich", async () => {
    const mockApi = createMockApi();
    vi.doMock("../api", () => ({ api: mockApi, isMockApi: true, apiErrorMessage: (_error: unknown, fallback: string) => fallback }));
    const [{ SkillsPage }, { ToastProvider }] = await Promise.all([import("./SkillsPage"), import("../components/overlays")]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><ToastProvider><MemoryRouter><SkillsPage /></MemoryRouter></ToastProvider></QueryClientProvider>);

    const imageRadio = await screen.findByRole("radio", { name: /siteindex-edm-manual-image/ });
    expect(imageRadio.closest(".si-skill-choice")?.textContent).toContain("1.0.0");
    fireEvent.click(imageRadio);
    expect(await screen.findByText(/通过 siteindex edm set-image 写入/)).toBeTruthy();
    expect(await mockApi.skills.get("siteindex-edm-manual-image")).toMatchObject({
      info: { version: "1.0.0", writes: ["index/ledgers/sku_media.csv", "index/views/products.jsonl"] },
    });

    const tagRadio = screen.getByRole("radio", { name: /sku-media-enrich/ });
    expect(tagRadio.closest(".si-skill-choice")?.textContent).toContain("1.2.0");
    fireEvent.click(tagRadio);
    expect(await screen.findByText(/本 Skill 不直接写入 sku_media.csv/)).toBeTruthy();
    expect((await mockApi.skills.get("sku-media-enrich")).info.writes).toEqual(["index/ledgers/sku_tags.csv"]);
  });

  it("renders a top-level empty state when the Skills API returns no items", async () => {
    const mockApi = createMockApi();
    vi.spyOn(mockApi.skills, "list").mockResolvedValue([]);
    vi.doMock("../api", () => ({ api: mockApi, isMockApi: true, apiErrorMessage: (_error: unknown, fallback: string) => fallback }));
    const [{ SkillsPage }, { ToastProvider }] = await Promise.all([import("./SkillsPage"), import("../components/overlays")]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(<QueryClientProvider client={queryClient}><ToastProvider><MemoryRouter><SkillsPage /></MemoryRouter></ToastProvider></QueryClientProvider>);

    const emptyHeading = await screen.findByRole("heading", { name: "当前没有可用的 Skill" });
    expect(emptyHeading.closest(".si-empty-state")).toBeTruthy();
    expect(container.querySelector(".si-page")).toBeNull();
    expect(screen.getByRole("button", { name: "重新检查" })).toBeTruthy();
  });

  it("labels retired edm-builder, retains its Agents directory copy, and offers no install action", async () => {
    const mockApi = createMockApi();
    const install = vi.spyOn(mockApi.skills, "install");
    vi.doMock("../api", () => ({
      api: mockApi,
      isMockApi: true,
      apiErrorMessage: (_error: unknown, fallback: string) => fallback,
    }));
    const [{ SkillsPage }, { ToastProvider }] = await Promise.all([
      import("./SkillsPage"),
      import("../components/overlays"),
    ]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ToastProvider><MemoryRouter><SkillsPage /></MemoryRouter></ToastProvider>
      </QueryClientProvider>,
    );

    expect(await screen.findByText("1.1.0 · 已退役")).toBeTruthy();
    expect(await screen.findByText("此 Skill 已退役")).toBeTruthy();
    expect(await screen.findByText("Agents 通用目录")).toBeTruthy();
    expect(await screen.findByText("已退役 · 保留副本")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "安装" })).toBeNull();
    expect(screen.queryByRole("button", { name: "更新" })).toBeNull();
    expect(screen.queryByRole("button", { name: "复制安装说明" })).toBeNull();
    expect(install).not.toHaveBeenCalled();

    await expect(mockApi.skills.install("edm-builder", "agents-dir")).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      message: "此 Skill 已退役，不能重新安装。",
    });
    await expect(mockApi.skills.targets("stock-report")).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ target_id: "agents-dir", name: "Agents 通用目录", status: "not_installed" }),
    ]));
  });

  it("shows a newer local version without offering an overwrite action", async () => {
    const mockApi = createMockApi();
    const install = vi.spyOn(mockApi.skills, "install");
    vi.doMock("../api", () => ({ api: mockApi, isMockApi: true, apiErrorMessage: (_error: unknown, fallback: string) => fallback }));
    const [{ SkillsPage }, { ToastProvider }] = await Promise.all([import("./SkillsPage"), import("../components/overlays")]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><ToastProvider><MemoryRouter><SkillsPage /></MemoryRouter></ToastProvider></QueryClientProvider>);

    fireEvent.click(await screen.findByRole("radio", { name: /stock-report/ }));
    expect((screen.getByRole("radio", { name: /stock-report/ }) as HTMLInputElement).checked).toBe(true);
    const status = await screen.findByText("本地版本较新（不覆盖）");
    const targetRow = status.closest(".si-skill-target");
    expect(targetRow).toBeTruthy();
    expect(within(targetRow as HTMLElement).queryByRole("button")).toBeNull();
    expect(install).not.toHaveBeenCalled();
    await expect(mockApi.skills.install("stock-report", "codex")).resolves.toMatchObject({
      status: "latest",
      local_newer: true,
    });
  });
});
