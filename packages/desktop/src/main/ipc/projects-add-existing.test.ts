import path from "node:path";
import type { AppSettings, ProjectSummary } from "@siteindex/shared";
import { describe, expect, it, vi } from "vitest";
import { createProjectsHandlers } from "./projects.js";
import type { IpcContext } from "./context.js";

describe("projects.addExisting background schedule registration", () => {
  it("returns the project summary without waiting for system task registration", async () => {
    const projectPath = path.join("C:\\fictional-cloud", "projects", "fictional-shop");
    let settings = {
      projects_root: path.join("C:\\fictional-cloud", "projects-root"),
      extra_projects: [],
      hidden_projects: [],
    } as unknown as AppSettings;
    const summary = { id: "fictional-shop", name: "Fictional Shop" } as ProjectSummary;
    const pendingScheduleRegistration = new Promise<void>(() => undefined);
    const reconcileProjectScheduleInBackground = vi.fn(() => pendingScheduleRegistration);
    const reconcileSchedules = vi.fn(async () => ({ mode: "system" as const, authorization_required: false }));
    const context = {
      settings: {
        get: vi.fn(async () => settings),
        set: vi.fn(async (patch: Partial<AppSettings>) => {
          settings = { ...settings, ...patch };
          return settings;
        }),
      },
      settingsChanged: vi.fn(async () => undefined),
      projects: {
        resolveExistingPath: vi.fn(async () => projectPath),
        refresh: vi.fn(async () => undefined),
        ensureProject: vi.fn(async () => undefined),
      },
      core: { projects: { get: vi.fn(async () => ({ summary })) } },
      reconcileProjectScheduleInBackground,
      reconcileSchedules,
    } as unknown as IpcContext;

    await expect(createProjectsHandlers(context)["projects.addExisting"]?.(projectPath)).resolves.toBe(summary);

    expect(reconcileProjectScheduleInBackground).toHaveBeenCalledWith("fictional-shop");
    expect(reconcileSchedules).not.toHaveBeenCalled();
    expect(context.settingsChanged).toHaveBeenCalledWith(settings, false, undefined);
  });
});
