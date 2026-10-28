import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: vi.fn(), getVersion: vi.fn() },
  clipboard: { writeText: vi.fn() },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  shell: { openPath: vi.fn(), openExternal: vi.fn(), trashItem: vi.fn() },
}));

import { API_EVENT_METHODS, API_INVOKE_METHODS } from "../../shared/ipc-contract.js";
import type { ProjectId } from "@siteindex/shared";
import { createIpcHandlerImplementations } from "./handlers.js";
import type { IpcContext } from "./context.js";

function testContext(): IpcContext {
  return {
    withProject: async <T>(_value: unknown, callback: (id: ProjectId) => Promise<T>) => callback("demo" as ProjectId),
    core: {
      design: { get: vi.fn(async () => ({ tokens: null, screenshots: [] })) },
      categories: {
        get: vi.fn(async () => ({ mode: "feed" })),
        preview: vi.fn(async () => ({ categories: [], unmapped: 0 })),
        save: vi.fn(async () => ({ categories: [], unmapped: 0 })),
      },
    },
    projects: { resolveProject: vi.fn(() => "C:/projects/demo") },
    jobs: { run: vi.fn(async () => ({ runId: "2026-10-28-index-check" })) },
  } as unknown as IpcContext;
}

describe("IPC handler completeness", () => {
  it("implements every SiteIndexApi invoke method, including optional namespaces", () => {
    const implementations = createIpcHandlerImplementations(testContext());
    expect(Object.keys(implementations).sort()).toEqual([...API_INVOKE_METHODS].sort());
    expect(API_INVOKE_METHODS).toContain("uiState.get");
    expect(API_INVOKE_METHODS).toContain("updates.check");
    expect(API_EVENT_METHODS).toContain("updates.onStatus");
  });

  it("delegates design, categories, and index-check requests to core and the JobManager", async () => {
    const context = testContext();
    const implementations = createIpcHandlerImplementations(context);

    await expect(implementations["design.get"]?.("demo")).resolves.toEqual({ tokens: null, screenshots: [] });
    await expect(implementations["categories.get"]?.("demo")).resolves.toEqual({ mode: "feed" });
    await expect(implementations["categories.preview"]?.("demo", { mode: "feed" })).resolves.toEqual({ categories: [], unmapped: 0 });
    await expect(implementations["categories.save"]?.("demo", { mode: "feed" })).resolves.toEqual({ categories: [], unmapped: 0 });
    await expect(implementations["seo.checkIndex"]?.("demo")).resolves.toEqual({ runId: "2026-10-28-index-check" });
    expect(context.jobs.run).toHaveBeenCalledWith({ projectPath: "C:/projects/demo", job: "index-check" });
  });
});
