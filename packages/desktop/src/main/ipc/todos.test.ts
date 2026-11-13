import { describe, expect, it, vi } from "vitest";
import type { ProjectId, TodoManualState, ProjectTodosResult } from "@siteindex/shared";
import type { CoreService } from "@siteindex/core";
import type { IpcContext } from "./context.js";
import { createTodosHandlers } from "./todos.js";

function contextWithTodos(todos: CoreService["todos"]): IpcContext {
  return {
    withProject: async <T>(value: unknown, callback: (id: ProjectId) => Promise<T>) =>
      callback(`${String(value)}-registered` as ProjectId),
    core: { todos },
  } as unknown as IpcContext;
}

describe("Todo IPC handlers", () => {
  it("routes list, status and note updates, and history through the project-scoped service", async () => {
    const listed: ProjectTodosResult = {
      items: [],
      scan: { status: "complete", evaluated_at: "2026-11-13T10:00:00.000Z" },
    };
    const state: TodoManualState = {
      dedupe_key: "todo:v1:fixture",
      status: "in_progress",
      note: null,
      updated_at: "2026-11-13T10:01:00.000Z",
    };
    const todos = {
      list: vi.fn(async () => listed),
      update: vi.fn(async () => state),
      history: vi.fn(async () => []),
    };
    const handlers = createTodosHandlers(contextWithTodos(todos as CoreService["todos"]));
    const input = { dedupe_key: "todo:v1:fixture", status: "in_progress" as const };
    const noteInput = { dedupe_key: "todo:v1:fixture", note: "synthetic review note" };

    await expect(handlers["todos.list"]?.("fixture-project")).resolves.toBe(listed);
    await expect(handlers["todos.update"]?.("fixture-project", input)).resolves.toBe(state);
    await expect(handlers["todos.update"]?.("fixture-project", noteInput)).resolves.toBe(state);
    await expect(handlers["todos.history"]?.("fixture-project", "todo:v1:fixture")).resolves.toEqual([]);
    expect(todos.list).toHaveBeenCalledWith("fixture-project-registered");
    expect(todos.update).toHaveBeenNthCalledWith(1, "fixture-project-registered", input);
    expect(todos.update).toHaveBeenNthCalledWith(2, "fixture-project-registered", noteInput);
    expect(todos.history).toHaveBeenCalledWith("fixture-project-registered", "todo:v1:fixture");
  });

  it("preserves Core service errors for the standard IPC serializer", async () => {
    const error = { code: "PROJECT_NOT_FOUND", message: "合成项目不存在。", detail: "fixture-project" };
    const todos = {
      list: vi.fn(async () => {
        throw error;
      }),
      update: vi.fn(async () => {
        throw error;
      }),
      history: vi.fn(async () => {
        throw error;
      }),
    };
    const handlers = createTodosHandlers(contextWithTodos(todos as unknown as CoreService["todos"]));

    await expect(handlers["todos.list"]?.("fixture-project")).rejects.toBe(error);
  });
});
