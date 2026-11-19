import { describe, expect, it, vi } from "vitest";
import type { ProjectId, SeoPageTableQuery, SeoPageTableResult } from "@siteindex/shared";
import { createApiBridge } from "../../preload/api.js";
import { createHandlerRegistry, serializeIpcError } from "../ipc-registry.js";
import type { IpcContext } from "./context.js";
import { createSeoHandlers } from "./seo.js";

const projectId = "fixture-project" as ProjectId;
const query: SeoPageTableQuery = { page: 2, pageSize: 20, filters: { summary: "open" } };
const result: SeoPageTableResult = {
  rows: [], total: 0,
  summary: { latest_crawl_date: "2026-11-19", open_pages: 1, new_pages: 0, unindexed_pages: 0, fixed_pages: 0 },
};

function setup() {
  const listPageRows = vi.fn(async () => result);
  const listPages = vi.fn(async () => ({ rows: [], total: 0 }));
  const context = {
    withProject: async <T>(value: unknown, callback: (id: ProjectId) => Promise<T>) => {
      if (value !== projectId) throw { code: "PROJECT_NOT_FOUND", message: "项目不存在" };
      return callback(projectId);
    },
    core: { seo: { listPageRows, listPages } },
  } as unknown as IpcContext;
  const registry = createHandlerRegistry(createSeoHandlers(context));
  const api = createApiBridge({
    invoke: async (channel, ...args) => {
      const handler = registry.get(channel);
      if (!handler) throw new Error(`Missing IPC handler: ${channel}`);
      try { return await handler(...args); }
      catch (error) { throw serializeIpcError(error); }
    },
    listen: () => () => undefined,
  });
  return { api, listPageRows, listPages };
}

describe("SEO page rows Desktop IPC", () => {
  it("passes the query and result through preload, IPC and Core while keeping listPages", async () => {
    const { api, listPageRows, listPages } = setup();
    await expect(api.seo.listPageRows?.(projectId, query)).resolves.toEqual(result);
    expect(listPageRows).toHaveBeenCalledWith(projectId, query);
    await expect(api.seo.listPages(projectId, { page: 1, pageSize: 20 })).resolves.toEqual({ rows: [], total: 0 });
    expect(listPages).toHaveBeenCalledWith(projectId, { page: 1, pageSize: 20 });
  });

  it("rejects an unknown project before calling Core", async () => {
    const { api, listPageRows } = setup();
    await expect(api.seo.listPageRows?.("missing" as ProjectId, query)).rejects.toMatchObject({
      code: "PROJECT_NOT_FOUND", message: "项目不存在",
    });
    expect(listPageRows).not.toHaveBeenCalled();
  });
});
