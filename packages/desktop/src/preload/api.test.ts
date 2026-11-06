import { describe, expect, it, vi } from "vitest";
import { createApiBridge } from "./api.js";

describe("createApiBridge IPC errors", () => {
  it("forwards read-only system task listing through the API bridge", async () => {
    const rows = [
      {
        taskName: "\\SiteIndex\\fixture-store-daily",
        projectId: "fixture-store",
        orphaned: false,
        job: "daily",
        systemState: "Ready",
        lastRunAt: null,
        lastResult: "0",
        nextRunAt: "2026-11-06T02:00:00+08:00",
        triggerSummary: "每个工作日 02:00",
        commandPath: "C:\\Fixture\\SiteIndex.exe",
        configMatches: true,
        differences: [],
      },
    ];
    const invoke = vi.fn(async (channel: string) => (channel === "si:schedule.listSystemTasks" ? rows : undefined));
    const bridge = createApiBridge({ invoke, listen: () => () => undefined });

    await expect(bridge.schedule.listSystemTasks?.()).resolves.toEqual(rows);
    expect(invoke).toHaveBeenCalledWith("si:schedule.listSystemTasks");
  });

  it("forwards listing and removal of orphaned system tasks", async () => {
    const orphan = {
      taskName: "\\SiteIndex\\sample-store-daily",
      path: "C:\\Fixture\\sample-store",
      reason: "missing",
    };
    const invoke = vi.fn(async (channel: string) => (channel === "si:schedule.listOrphans" ? [orphan] : undefined));
    const bridge = createApiBridge({ invoke, listen: () => () => undefined });

    await expect(bridge.schedule.listOrphans?.()).resolves.toEqual([
      { taskName: "\\SiteIndex\\sample-store-daily", path: "C:\\Fixture\\sample-store", reason: "missing" },
    ]);
    await expect(bridge.schedule.removeOrphan?.("\\SiteIndex\\sample-store-daily")).resolves.toBeUndefined();
    expect(invoke.mock.calls).toEqual([
      ["si:schedule.listOrphans"],
      ["si:schedule.removeOrphan", "\\SiteIndex\\sample-store-daily"],
    ]);
  });

  it("forwards project removal and restores a task cleanup warning", async () => {
    const invoke = vi.fn(async () => {
      throw new Error(
        'Error invoking remote method: __SITEINDEX_IPC_ERROR__:{"code":"UNKNOWN","message":"项目已取消登记，但注销系统计划任务需要管理员授权。"}',
      );
    });
    const bridge = createApiBridge({ invoke, listen: () => () => undefined });
    await expect(bridge.projects.remove?.("fictional")).rejects.toMatchObject({
      code: "UNKNOWN",
      message: expect.stringContaining("项目已取消登记"),
    });
    expect(invoke).toHaveBeenCalledWith("si:projects.remove", "fictional");
  });
  it("restores a serialized error when Electron prefixes the remote method context", async () => {
    const bridge = createApiBridge({
      invoke: async () => {
        throw new Error(
          'Error invoking remote method \'si:projects.inspectFeed\': Error: __SITEINDEX_IPC_ERROR__:{"code":"FEED_INVALID","message":"Feed 地址无效","detail":"HTTP 403"}',
        );
      },
      listen: () => () => undefined,
    });

    await expect(
      bridge.projects.inspectFeed(["https://example.test/feed.xml"], {
        sku_field: "id",
        category_depth: 2,
      }),
    ).rejects.toMatchObject({
      code: "FEED_INVALID",
      message: "Feed 地址无效",
      detail: "HTTP 403",
    });
  });

  it("preserves unrelated transport errors", async () => {
    const transportError = new Error("IPC channel unavailable");
    const bridge = createApiBridge({
      invoke: async () => {
        throw transportError;
      },
      listen: () => () => undefined,
    });

    await expect(bridge.projects.inspectFeed([], { sku_field: "id", category_depth: 2 })).rejects.toBe(transportError);
  });

  it("forwards SKU grouping previews through the API bridge", async () => {
    const result = {
      parents: 1,
      children: 2,
      samples: [{ parent: "parent", children: ["parent-A", "parent-B"] }],
      unmatched: 1,
    };
    const invoke = vi.fn(async () => result);
    const bridge = createApiBridge({ invoke, listen: () => () => undefined });
    const rule = { type: "suffix" as const, value: "-A" };

    await expect(bridge.sku?.previewGrouping("demo", rule)).resolves.toEqual(result);
    expect(invoke).toHaveBeenCalledWith("si:sku.previewGrouping", "demo", rule);
  });

  it("restores Core validation errors from SKU grouping IPC", async () => {
    const bridge = createApiBridge({
      invoke: async () => {
        throw new Error(
          'Error invoking remote method \'si:sku.previewGrouping\': Error: __SITEINDEX_IPC_ERROR__: {"code":"CONFIG_INVALID","message":"SKU 分组规则无效","detail":"正则表达式语法无效"}',
        );
      },
      listen: () => () => undefined,
    });

    await expect(bridge.sku?.previewGrouping("demo", { type: "regex", value: "[" })).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      message: "SKU 分组规则无效",
      detail: "正则表达式语法无效",
    });
  });

  it("forwards SEO issue and rule status updates through the API bridge", async () => {
    const results = [{ updated: 1 }, { updated: 2 }, { updated: 2 }, { updated: 1 }];
    const invoke = vi.fn(async () => results.shift());
    const bridge = createApiBridge({ invoke, listen: () => () => undefined });
    const singleInput = {
      targets: [{ url: "https://shop.example.test/page-a", rule: "desc_missing" as const }],
      status: "ignored" as const,
    };
    const batchInput = {
      targets: [
        { url: "https://shop.example.test/page-a", rule: "desc_missing" as const },
        { url: "https://shop.example.test/page-b", rule: "title_missing" as const },
      ],
      status: "fixed" as const,
    };

    await expect(bridge.seo.setIssueStatus?.("demo", singleInput)).resolves.toEqual({ updated: 1 });
    await expect(bridge.seo.setIssueStatus?.("demo", batchInput)).resolves.toEqual({ updated: 2 });
    await expect(bridge.seo.setRuleIgnored?.("demo", "desc_missing", true)).resolves.toEqual({ updated: 2 });
    await expect(bridge.seo.setRuleIgnored?.("demo", "desc_missing", false)).resolves.toEqual({ updated: 1 });
    expect(invoke.mock.calls).toEqual([
      ["si:seo.setIssueStatus", "demo", singleInput],
      ["si:seo.setIssueStatus", "demo", batchInput],
      ["si:seo.setRuleIgnored", "demo", "desc_missing", true],
      ["si:seo.setRuleIgnored", "demo", "desc_missing", false],
    ]);
  });
});
