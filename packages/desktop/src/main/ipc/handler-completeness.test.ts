import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: vi.fn(), getVersion: vi.fn() },
  clipboard: { writeText: vi.fn() },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  shell: { openPath: vi.fn(), openExternal: vi.fn(), trashItem: vi.fn() },
}));

import { API_EVENT_METHODS, API_INVOKE_METHODS, PENDING_HANDLERS } from "@siteindex/shared";
import type { AppSettings, ProjectId } from "@siteindex/shared";
import { createApiBridge } from "../../preload/api.js";
import { createJobManager } from "../job-manager.js";
import { createHandlerRegistry, serializeIpcError } from "../ipc-registry.js";
import { createIpcHandlerImplementations } from "./handlers.js";
import type { IpcContext } from "./context.js";

function testContext(): IpcContext {
  return {
    withProject: async <T>(_value: unknown, callback: (id: ProjectId) => Promise<T>) => callback("demo" as ProjectId),
    core: {
      workspace: {
        check: vi.fn(async () => ({ ok: true, invalid_entries: [] })),
        create: vi.fn(async () => ({ path: "C:/projects/demo", created: ["README.md"] })),
        importCheck: vi.fn(async () => ({ issues: [], repaired: [] })),
      },
      invalidate: vi.fn(),
      design: { get: vi.fn(async () => ({ tokens: null, screenshots: [] })) },
      projects: {
        createWorkspaceOnly: vi.fn(async () => ({ id: "workspace-demo" })),
        resolveProject: vi.fn(() => "C:/projects/demo"),
      },
      categories: {
        get: vi.fn(async () => ({ mode: "feed" })),
        preview: vi.fn(async () => ({ categories: [], unmapped: 0 })),
        save: vi.fn(async () => ({ categories: [], unmapped: 0 })),
      },
      sku: {
        previewGrouping: vi.fn(async () => ({
          parents: 1,
          children: 2,
          samples: [{ parent: "parent", children: ["parent-A", "parent-B"] }],
          unmatched: 1,
        })),
      },
    },
    projects: { resolveProject: vi.fn(() => "C:/projects/demo") },
    jobs: {
      run: vi.fn(async () => ({ runId: "2026-10-28-index-check" })),
      runMedia: vi.fn(async () => ({ runId: "2026-10-28-media" })),
    },
  } as unknown as IpcContext;
}

function apiBridgeFor(context: IpcContext) {
  const registry = createHandlerRegistry(createIpcHandlerImplementations(context));
  return createApiBridge({
    invoke: async (channel, ...args) => {
      const handler = registry.get(channel);
      if (!handler) throw new Error(`Missing IPC handler for ${channel}`);
      try {
        return await handler(...args);
      } catch (error) {
        throw serializeIpcError(error);
      }
    },
    listen: () => () => undefined,
  });
}

describe("IPC handler completeness", () => {
  it("implements every SiteIndexApi invoke method, including optional namespaces", () => {
    const implementations = createIpcHandlerImplementations(testContext());
    const apiMethods = new Set<string>(API_INVOKE_METHODS);
    const pendingMethods = new Set(PENDING_HANDLERS);
    const registeredMethods = Object.keys(implementations);
    const registeredSet = new Set(registeredMethods);
    const missingMethods = API_INVOKE_METHODS.filter((method) => !registeredSet.has(method));

    expect([...pendingMethods].filter((method) => !apiMethods.has(method))).toEqual([]);
    expect(PENDING_HANDLERS).toHaveLength(pendingMethods.size);
    expect(registeredMethods.filter((method) => !apiMethods.has(method))).toEqual([]);
    expect(missingMethods.filter((method) => !pendingMethods.has(method))).toEqual([]);
    expect(pendingMethods).toContain("edm.exportIndex");
    expect(registeredSet.has("media.prepare")).toBe(true);
    expect(registeredSet.has("edm.exportIndex")).toBe(true);
    expect(API_INVOKE_METHODS).toContain("uiState.get");
    expect(API_INVOKE_METHODS).toContain("updates.check");
    expect(API_EVENT_METHODS).toContain("updates.onStatus");
  });

  it("delegates design, categories, and index-check requests to core and the JobManager", async () => {
    const context = testContext();
    const implementations = createIpcHandlerImplementations(context);

    await expect(implementations["design.get"]?.("demo")).resolves.toEqual({ tokens: null, screenshots: [] });
    await expect(implementations["categories.get"]?.("demo")).resolves.toEqual({ mode: "feed" });
    await expect(implementations["categories.preview"]?.("demo", { mode: "feed" })).resolves.toEqual({
      categories: [],
      unmapped: 0,
    });
    await expect(implementations["categories.save"]?.("demo", { mode: "feed" })).resolves.toEqual({
      categories: [],
      unmapped: 0,
    });
    await expect(implementations["sku.previewGrouping"]?.("demo", { type: "suffix", value: "-A" })).resolves.toEqual({
      parents: 1,
      children: 2,
      samples: [{ parent: "parent", children: ["parent-A", "parent-B"] }],
      unmatched: 1,
    });
    await expect(implementations["seo.checkIndex"]?.("demo")).resolves.toEqual({ runId: "2026-10-28-index-check" });
    await expect(implementations["media.prepare"]?.({ project: "demo", skus: ["fictional-sku"] })).resolves.toEqual({
      runId: "2026-10-28-media",
    });
    expect(context.jobs.run).toHaveBeenCalledWith({ projectPath: "C:/projects/demo", job: "index-check" });
    expect(context.jobs.runMedia).toHaveBeenCalledWith({
      projectPath: "C:/projects/demo",
      job: "media",
      skus: ["fictional-sku"],
    });
  });

  it("rejects malformed media requests before starting a worker", async () => {
    const context = testContext();
    const handler = createIpcHandlerImplementations(context)["media.prepare"];
    if (!handler) throw new Error("media.prepare handler missing");

    await expect(
      Promise.resolve().then(() => handler({ project: "demo", skus: ["fictional-sku", 1] })),
    ).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
    await expect(Promise.resolve().then(() => handler({ project: "demo", skus: [] }))).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
    expect(context.jobs.runMedia).not.toHaveBeenCalled();
  });

  it("keeps the real media IPC handler away from the credential vault until Core is ready", async () => {
    const settings: AppSettings = {
      device_id: "fixture-device",
      device_name: "Fixture Device",
      projects_root: "",
      extra_projects: [],
      cache_dir: "C:/Fixture/cache",
      browser: { channel: "msedge", executable_path: "C:/Fixture/msedge.exe" },
      notify: { on_failure: true, on_success: false, oos_threshold: 0.12, dingtalk_webhook: null },
      skill_platforms: [],
      conflict_patterns: [],
    };
    const getSettings = vi.fn(async () => settings);
    const getWordPressCredential = vi.fn(async () => ({
      username: "fixture-user",
      applicationPassword: "fixture-app-password",
    }));
    const fork = vi.fn(() => {
      throw new Error("media worker must stay gated");
    });
    const context = testContext();
    context.jobs = createJobManager({
      workerPath: "fixture-worker.js",
      getSettings,
      isMediaJobReady: () => false,
      getWordPressCredential,
      resolveProject: () => "C:/projects/demo",
      fork,
      emitProgress: vi.fn(),
      emitFinished: vi.fn(),
      notify: vi.fn(),
    });
    const bridge = apiBridgeFor(context);
    await expect(bridge.media?.prepare({ project: "demo", skus: ["fixture-sku"] })).rejects.toMatchObject({
      code: "NOT_IMPLEMENTED",
      message: "当前桌面版本尚未接入媒体准备 Core Job。",
    });
    expect(getSettings).not.toHaveBeenCalled();
    expect(getWordPressCredential).not.toHaveBeenCalled();
    expect(fork).not.toHaveBeenCalled();
  });

  it("keeps EDM export gated through the handler registry and preload while readiness is pending", async () => {
    const context = testContext();
    const exportIndex = vi.fn(async () => ({ status: "created" }));
    Object.assign(context.core, { edm: { exportIndex } });
    const bridge = apiBridgeFor(context);

    expect(PENDING_HANDLERS).toContain("edm.exportIndex");
    await expect(bridge.edm.exportIndex?.("demo")).rejects.toMatchObject({
      code: "NOT_IMPLEMENTED",
      message: "当前版本尚未接入 EDM SKU 清单生成。",
      detail: "Core edm.exportIndex 尚未就绪。",
    });
    expect(exportIndex).not.toHaveBeenCalled();
  });

  it("forwards workspace validation and creation to Core without changing their inputs", async () => {
    const context = testContext();
    const implementations = createIpcHandlerImplementations(context);
    const createInput = {
      targetDir: "C:/Fixture/workspace",
      domain: "fixture.example.test",
      brand: { name: "Fixture", voice: "清晰" },
      platform: "other" as const,
      esp_presets: [],
    };

    await expect(implementations["workspace.check"]?.("C:/Fixture/workspace")).resolves.toEqual({
      ok: true,
      invalid_entries: [],
    });
    await expect(implementations["workspace.create"]?.(createInput)).resolves.toEqual({
      path: "C:/projects/demo",
      created: ["README.md"],
    });
    expect(context.core.workspace.check).toHaveBeenCalledWith("C:/Fixture/workspace");
    expect(context.core.workspace.create).toHaveBeenCalledWith(createInput);
  });

  it("forwards workspace import checks and invalidates Core after applied repairs", async () => {
    const context = testContext();
    const implementations = createIpcHandlerImplementations(context);
    const handler = implementations["workspace.importCheck"];
    const cleanResult = { issues: [], repaired: [] };
    const repairedResult = { issues: [], repaired: ["_site-index/workspace.json"] };

    vi.mocked(context.core.workspace.importCheck)
      .mockResolvedValueOnce(cleanResult)
      .mockResolvedValueOnce(repairedResult);

    await expect(handler?.("demo")).resolves.toEqual(cleanResult);
    expect(context.core.workspace.importCheck).toHaveBeenNthCalledWith(1, "demo", undefined);
    expect(context.core.invalidate).not.toHaveBeenCalled();

    await expect(handler?.("demo", { apply: true })).resolves.toEqual(repairedResult);
    expect(context.core.workspace.importCheck).toHaveBeenNthCalledWith(2, "demo", { apply: true });
    expect(context.core.invalidate).toHaveBeenCalledWith("C:/projects/demo");
  });

  it("registers a workspace-only project handler", () => {
    const context = testContext();
    const implementations = createIpcHandlerImplementations(context);
    expect(implementations["projects.createWorkspaceOnly"]).toBeTypeOf("function");
  });
});
