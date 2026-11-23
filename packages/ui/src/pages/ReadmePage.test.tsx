// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { createMockApi } from "../mock";

afterEach(() => {
  cleanup();
  vi.doUnmock("../api");
  vi.resetModules();
});

describe("ReadmePage missing user sections", () => {
  it("shows the missing heading and clears the notice after save and readback", async () => {
    const mockApi = createMockApi();
    const getReadme = mockApi.readme.get;
    const saveBlocks = mockApi.readme.saveUserBlocks;
    let missing = true;
    vi.spyOn(mockApi.readme, "get").mockImplementation(async (id) => ({
      ...await getReadme(id),
      ...(missing ? { missing_user_blocks: ["focus" as const] } : {}),
    }));
    const save = vi.spyOn(mockApi.readme, "saveUserBlocks").mockImplementation(async (id, blocks) => {
      await saveBlocks(id, blocks);
      missing = false;
    });
    vi.doMock("../api", () => ({ api: mockApi, apiErrorMessage: (_error: unknown, fallback: string) => fallback }));
    const [{ ReadmePage }, { ToastProvider }] = await Promise.all([import("./ReadmePage"), import("../components/overlays")]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><ToastProvider><MemoryRouter initialEntries={["/p/demo/readme"]}>
      <Routes><Route path="/p/:id/readme" element={<ReadmePage />} /></Routes>
    </MemoryRouter></ToastProvider></QueryClientProvider>);

    expect(await screen.findByText("README 段落缺失")).toBeTruthy();
    expect(screen.getByText(/缺少：当前重点。保存后会补齐标题并写入内容。/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByText("README 段落缺失")).toBeNull());
  });
});
