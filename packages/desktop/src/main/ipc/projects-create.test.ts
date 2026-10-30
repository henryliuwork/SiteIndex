import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PATHS, type AppSettings, type CreateProjectInput } from "@siteindex/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { serializeIpcError } from "../ipc-registry.js";
import { createProjectsHandlers } from "./projects.js";
import type { IpcContext } from "./context.js";

const tempRoots: string[] = [];
afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("projects.create Desktop flow", () => {
  it("indexes a selected root, claims this device, starts init and returns its IPC runId", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "siteindex-create-ipc-"));
    tempRoots.push(root);
    const defaultRoot = path.join(root, "default");
    const selectedRoot = path.join(root, "selected");
    const projectPath = path.join(selectedRoot, "example");
    await mkdir(defaultRoot);
    const settings: AppSettings = {
      device_id: "test-device",
      device_name: "Test Device",
      projects_root: defaultRoot,
      extra_projects: [],
      cache_dir: path.join(root, "cache"),
      browser: { channel: "msedge", executable_path: null },
      notify: { on_failure: false, on_success: false, oos_threshold: null, dingtalk_webhook: null },
      skill_platforms: [],
      conflict_patterns: [],
    };
    const input: CreateProjectInput = {
      url: "https://example.com",
      feed_urls: ["https://example.com/feed.xml"],
      sku_field: "id",
      category_depth: 1,
      missing_as: "out_of_stock",
      brand: { name: "Example" },
      markets: [],
      projects_root: selectedRoot,
      folder_name: "example",
      workspace_folders: [],
    };
    let saved = settings;
    const settingsChanged = vi.fn(async () => undefined);
    const reconcileSchedules = vi.fn(async () => ({ mode: "system" as const, authorization_required: false }));
    const run = vi.fn(async () => ({ runId: "desktop-init-run-id" }));
    const invalidate = vi.fn();
    const refresh = vi.fn(async () => []);
    const context = {
      core: {
        projects: {
          create: vi.fn(async () => {
            await mkdir(projectPath, { recursive: true });
            return { id: "example", runId: "core-init-run-id" };
          }),
        },
        invalidate,
      },
      projects: { refresh, resolveProject: () => projectPath },
      settings: {
        get: async () => saved,
        set: async (patch: Partial<AppSettings>) => {
          saved = { ...saved, ...patch };
          return saved;
        },
      },
      settingsChanged,
      jobs: { run },
      reconcileSchedules,
    } as unknown as IpcContext;

    const result = await createProjectsHandlers(context)["projects.create"]?.(input);
    expect(result).toEqual({ id: "example", runId: "desktop-init-run-id" });
    expect(run).toHaveBeenCalledWith({ projectPath, job: "init" });
    expect(saved.extra_projects).toEqual([projectPath]);
    expect(settingsChanged).toHaveBeenCalledWith(saved, false);
    expect(refresh).toHaveBeenCalledWith(saved);
    expect(reconcileSchedules).not.toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledWith(projectPath);
    expect(JSON.parse(await readFile(path.join(projectPath, PATHS.runner), "utf8"))).toMatchObject({
      device_id: settings.device_id,
      device_name: settings.device_name,
    });
  });

  it("serializes concurrent creates so the first project is registered before the next Core check", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "siteindex-create-queue-"));
    tempRoots.push(root);
    const projectsRoot = path.join(root, "default");
    const selectedRoot = path.join(root, "selected");
    await mkdir(projectsRoot);
    let saved: AppSettings = {
      device_id: "test-device",
      device_name: "Test Device",
      projects_root: projectsRoot,
      extra_projects: [],
      cache_dir: path.join(root, "cache"),
      browser: { channel: "msedge", executable_path: null },
      notify: { on_failure: false, on_success: false, oos_threshold: null, dingtalk_webhook: null },
      skill_platforms: [],
      conflict_patterns: [],
    };
    const registeredPaths = new Map<string, string>();
    const registeredWhenCreateStarted: string[][] = [];
    let unblockFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { unblockFirst = resolve; });
    let signalFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { signalFirstStarted = resolve; });
    const create = vi.fn(async (input: CreateProjectInput) => {
      const projectPath = path.join(input.projects_root, input.folder_name);
      await mkdir(projectPath, { recursive: true });
      registeredWhenCreateStarted.push([...saved.extra_projects]);
      if (input.folder_name === "first") {
        signalFirstStarted();
        await firstGate;
      }
      return { id: input.folder_name, runId: `core-${input.folder_name}` };
    });
    const refresh = vi.fn(async (nextSettings: AppSettings) => {
      for (const projectPath of nextSettings.extra_projects) {
        registeredPaths.set(path.basename(projectPath), projectPath);
      }
      return [];
    });
    const context = {
      core: { projects: { create }, invalidate: vi.fn() },
      projects: {
        refresh,
        resolveProject: (id: string) => registeredPaths.get(id) ?? path.join(selectedRoot, id),
      },
      settings: {
        get: async () => saved,
        set: async (patch: Partial<AppSettings>) => {
          saved = { ...saved, ...patch };
          return saved;
        },
      },
      settingsChanged: vi.fn(async () => undefined),
      jobs: { run: vi.fn(async ({ projectPath }: { projectPath: string }) => ({ runId: `desktop-${path.basename(projectPath)}` })) },
    } as unknown as IpcContext;
    const handler = createProjectsHandlers(context)["projects.create"]!;
    const input = (folderName: string): CreateProjectInput => ({
      url: "https://example.com",
      feed_urls: [],
      sku_field: "id",
      category_depth: 1,
      missing_as: "out_of_stock",
      brand: { name: "Example" },
      markets: [],
      projects_root: selectedRoot,
      folder_name: folderName,
      workspace_folders: [],
    });

    const first = handler(input("first"));
    await firstStarted;
    const second = handler(input("second"));
    await Promise.resolve();
    const callsBeforeFirstRegistration = create.mock.calls.length;
    unblockFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { id: "first", runId: "desktop-first" },
      { id: "second", runId: "desktop-second" },
    ]);

    expect(callsBeforeFirstRegistration).toBe(1);
    expect(registeredWhenCreateStarted[1]).toContain(path.join(selectedRoot, "first"));
    expect(saved.extra_projects).toEqual([path.join(selectedRoot, "first"), path.join(selectedRoot, "second")]);
  });

  it("preserves duplicate errors for IPC and performs no registration or init side effects", async () => {
    const duplicateError = {
      code: "FOLDER_EXISTS",
      message: "该站点已经登记。",
      detail: "example.com",
    };
    const set = vi.fn();
    const settingsChanged = vi.fn();
    const refresh = vi.fn();
    const run = vi.fn();
    const context = {
      core: {
        projects: { create: vi.fn(async () => { throw duplicateError; }) },
        invalidate: vi.fn(),
      },
      projects: { refresh, resolveProject: vi.fn() },
      settings: { get: vi.fn(), set },
      settingsChanged,
      jobs: { run },
    } as unknown as IpcContext;
    const input = {
      url: "https://example.com",
      feed_urls: [],
      sku_field: "id",
      category_depth: 1,
      missing_as: "out_of_stock",
      brand: { name: "Example" },
      markets: [],
      projects_root: "C:/projects",
      folder_name: "example",
      workspace_folders: [],
    } satisfies CreateProjectInput;

    const error = await Promise.resolve(createProjectsHandlers(context)["projects.create"]!(input)).then(
      () => null,
      (value: unknown) => value,
    );

    expect(error).toBe(duplicateError);
    expect(serializeIpcError(error).message).toBe(
      "__SITEINDEX_IPC_ERROR__:{\"code\":\"FOLDER_EXISTS\",\"message\":\"该站点已经登记。\",\"detail\":\"example.com\"}",
    );
    expect(set).not.toHaveBeenCalled();
    expect(settingsChanged).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
});
