import { describe, expect, it, vi } from "vitest";

const { showMessageBox } = vi.hoisted(() => ({ showMessageBox: vi.fn(async () => ({ response: 0 })) }));
vi.mock("electron", () => ({ dialog: { showMessageBox } }));

import { createScheduleHandlers } from "./schedule.js";
import type { IpcContext } from "./context.js";

function testContext() {
  const refresh = vi.fn(async () => [{ id: "active" as never, path: "C:\\Synthetic\\active" }]);
  const listOrphans = vi.fn(async () => [
    { taskName: "\\SiteIndex\\moved-daily", path: "C:\\Synthetic\\missing", reason: "目录不存在" },
  ]);
  const removeOrphan = vi.fn(async () => undefined);
  const context = {
    settings: { get: vi.fn(async () => ({ projects_root: "", extra_projects: [] })) },
    projects: { refresh },
    scheduler: { listOrphans, removeOrphan },
  } as unknown as IpcContext;
  return { context, refresh, listOrphans, removeOrphan };
}

describe("schedule orphan IPC confirmation", () => {
  it("requires explicit confirmation and enumerates through the project catalog", async () => {
    showMessageBox.mockClear();
    const { context, refresh, listOrphans, removeOrphan } = testContext();
    const handlers = createScheduleHandlers(context);
    await expect(handlers["schedule.listOrphans"]?.()).resolves.toHaveLength(1);
    expect(refresh).toHaveBeenCalledOnce();
    expect(listOrphans).toHaveBeenCalledWith([{ projectPath: "C:\\Synthetic\\active" }]);

    showMessageBox.mockResolvedValueOnce({ response: 0 });
    await expect(handlers["schedule.removeOrphan"]?.("\\SiteIndex\\moved-daily")).resolves.toBeUndefined();
    expect(removeOrphan).not.toHaveBeenCalled();

    showMessageBox.mockResolvedValueOnce({ response: 1 });
    await handlers["schedule.removeOrphan"]?.("\\SiteIndex\\moved-daily");
    expect(removeOrphan).toHaveBeenCalledWith("\\SiteIndex\\moved-daily");
  });

  it("rejects tasks outside the SiteIndex namespace before showing confirmation", async () => {
    showMessageBox.mockClear();
    const { context, removeOrphan } = testContext();
    await expect(
      createScheduleHandlers(context)["schedule.removeOrphan"]?.("\\Other\\backup-daily"),
    ).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
    expect(showMessageBox).not.toHaveBeenCalled();
    expect(removeOrphan).not.toHaveBeenCalled();
  });
});
