import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PATHS, type AppSettings, type CreateProjectInput } from "@siteindex/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
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
});
