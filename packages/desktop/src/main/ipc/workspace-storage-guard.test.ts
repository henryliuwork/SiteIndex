import { describe, expect, it, vi } from "vitest";
import { createWorkspaceHandlers } from "./workspace.js";
import type { IpcContext } from "./context.js";

describe("workspace Desktop cloud-storage guards", () => {
  it("rejects workspace creation before Core writes", async () => {
    const storageError = Object.assign(new Error("此目录仅支持只读查看。"), {
      code: "PROJECT_CLOUD_SYNC_UNSUPPORTED",
    });
    const targetDir = "C:\\FictionalDrive\\SiteIndex\\fixture-shop";
    const create = vi.fn();
    const context = {
      assertProjectStorageLocal: vi.fn(async () => {
        throw storageError;
      }),
      core: { workspace: { create } },
    } as unknown as IpcContext;

    await expect(
      createWorkspaceHandlers(context)["workspace.create"]?.({ targetDir }),
    ).rejects.toBe(storageError);

    expect(context.assertProjectStorageLocal).toHaveBeenCalledWith(targetDir);
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects an applying import before Core changes project files", async () => {
    const storageError = Object.assign(new Error("此目录仅支持只读查看。"), {
      code: "PROJECT_CLOUD_SYNC_UNSUPPORTED",
    });
    const projectPath = "C:\\FictionalDrive\\SiteIndex\\fixture-shop";
    const importCheck = vi.fn();
    const context = {
      assertProjectStorageLocal: vi.fn(async () => {
        throw storageError;
      }),
      projects: { resolveProject: vi.fn(() => projectPath) },
      core: { workspace: { importCheck } },
      withProject: async (_id: unknown, callback: (projectId: "fixture-shop") => Promise<unknown>) =>
        callback("fixture-shop"),
    } as unknown as IpcContext;

    await expect(
      createWorkspaceHandlers(context)["workspace.importCheck"]?.("fixture-shop", { apply: true }),
    ).rejects.toBe(storageError);

    expect(context.projects.resolveProject).toHaveBeenCalledWith("fixture-shop");
    expect(context.assertProjectStorageLocal).toHaveBeenCalledWith(projectPath);
    expect(importCheck).not.toHaveBeenCalled();
  });
});
