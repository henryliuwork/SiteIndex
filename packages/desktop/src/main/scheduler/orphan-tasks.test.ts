import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSystemScheduler, parseWindowsTaskNamesCsv } from "./schedule.js";
import type { WindowsTaskRegistrar } from "./windows-tasks.js";

const tempRoots: string[] = [];
afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("orphan scheduled tasks", () => {
  it("parses CSV names while retaining only the SiteIndex namespace", () => {
    expect(
      parseWindowsTaskNamesCsv(
        '"\\SiteIndex\\old-store-daily","N/A","Ready"\r\n"\\Other\\backup","N/A","Ready"\r\n"SiteIndex - removed-weekly","N/A","Ready"',
      ),
    ).toEqual(["\\SiteIndex\\old-store-daily", "SiteIndex - removed-weekly"]);
  });

  it("lists only SiteIndex tasks whose project path is missing or unregistered", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "siteindex-orphan-list-"));
    tempRoots.push(directory);
    const activePath = path.join(directory, "active-project");
    const missingPath = path.join(directory, "moved-project");
    await mkdir(activePath);
    const queried: string[] = [];
    const scheduler = createSystemScheduler({
      platform: "win32",
      executablePath: "unused.exe",
      runCommand: async (_file, args) => {
        if (args[0] === "/Query" && args[1] === "/FO") {
          return `"\\SiteIndex\\moved-daily","N/A","Ready"\r\n"\\SiteIndex\\active-daily","N/A","Ready"\r\n"\\Other\\backup","N/A","Ready"`;
        }
        const taskName = args[2] ?? "";
        queried.push(taskName);
        const projectPath = taskName.includes("moved") ? missingPath : activePath;
        return `<Task><Actions><Exec><Arguments>--run-job &quot;${projectPath}&quot; daily</Arguments></Exec></Actions></Task>`;
      },
    });

    await expect(scheduler.listOrphans([{ projectPath: activePath }])).resolves.toEqual([
      { taskName: "\\SiteIndex\\moved-daily", path: missingPath, reason: "任务指向的项目路径已不存在。" },
    ]);
    expect(queried).toEqual(["\\SiteIndex\\moved-daily", "\\SiteIndex\\active-daily"]);
  });

  it("refuses to remove names outside SiteIndex and deletes only the requested task", async () => {
    const reconcile = vi.fn(async (..._args: Parameters<WindowsTaskRegistrar["reconcile"]>) => ({
      mode: "system" as const,
      authorization_required: false,
      registered_task_names: [],
    }));
    const scheduler = createSystemScheduler({
      platform: "win32",
      executablePath: "unused.exe",
      windowsTaskRegistrar: { reconcile },
    });

    await expect(scheduler.removeOrphan("\\Other\\backup-daily")).rejects.toThrow("SiteIndex");
    expect(reconcile).not.toHaveBeenCalled();
    await scheduler.removeOrphan("\\SiteIndex\\moved-daily");
    expect(reconcile).toHaveBeenCalledWith([], ["\\SiteIndex\\moved-daily"], [], true, "system");
  });
});
