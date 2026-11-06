import { describe, expect, it, vi } from "vitest";
import { createScheduleHandlers } from "./schedule.js";
import type { IpcContext } from "./context.js";
import type { ScheduleConfig } from "@siteindex/shared";

describe("schedule.listSystemTasks IPC", () => {
  it("loads registered project configurations and delegates a read-only list", async () => {
    const settings = { projects_root: "C:\\Synthetic", extra_projects: [] };
    const entries = [{ id: "fixture-store", path: "C:\\Synthetic\\fixture-store" }];
    const config = {} as ScheduleConfig;
    const rows: unknown[] = [];
    const refresh = vi.fn(async () => entries);
    const getSchedule = vi.fn(async () => ({ config }));
    const listSystemTasks = vi.fn(async () => rows);
    const context = {
      settings: { get: vi.fn(async () => settings) },
      projects: { refresh },
      core: { schedule: { get: getSchedule } },
      scheduler: { listSystemTasks },
    } as unknown as IpcContext;

    const result = await createScheduleHandlers(context)["schedule.listSystemTasks"]?.();

    expect(result).toEqual(rows);
    expect(refresh).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledWith(settings);
    expect(getSchedule).toHaveBeenCalledOnce();
    expect(getSchedule).toHaveBeenCalledWith("fixture-store");
    expect(listSystemTasks).toHaveBeenCalledOnce();
    expect(listSystemTasks).toHaveBeenCalledWith([
      { projectId: "fixture-store", projectPath: "C:\\Synthetic\\fixture-store", config },
    ]);
  });
});
