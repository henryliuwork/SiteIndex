import { describe, expect, it, vi } from "vitest";
import type { ProjectId } from "@siteindex/shared";
import { createApiBridge } from "../../preload/api.js";
import { createHandlerRegistry, serializeIpcError } from "../ipc-registry.js";
import type { IpcContext } from "./context.js";
import { createEdmHandlers } from "./edm.js";
import { createProductsHandlers } from "./products.js";
import { createSeoHandlers } from "./seo.js";

const projectId = "fixture-project" as ProjectId;
const url = "https://fixture.example.test/page";
const sku = "fixture-sku";
const result = {
  data: { fixture: true },
  metadata: {
    sources: ["index/products.jsonl"],
    collected_at: "2026-01-01T00:00:00.000Z",
    missing_fields: [],
    quality: "complete" as const,
    anomalies: [],
  },
};

function setup() {
  const methods = {
    pageBrief: vi.fn(async () => result),
    issueCandidates: vi.fn(async () => result),
    internalLinkContext: vi.fn(async () => result),
    skuBrief: vi.fn(async () => result),
    changes: vi.fn(async () => result),
    groupFamily: vi.fn(async () => result),
    candidates: vi.fn(async () => result),
    mediaGaps: vi.fn(async () => result),
    campaignSafety: vi.fn(async () => result),
  };
  const context = {
    withProject: vi.fn(async <T>(value: unknown, callback: (id: ProjectId) => Promise<T>) => {
      if (value !== projectId) throw { code: "PROJECT_NOT_FOUND", message: "项目不存在" };
      return callback(projectId);
    }),
    core: {
      seo: methods,
      products: methods,
      edm: methods,
    },
  } as unknown as IpcContext;
  const registry = createHandlerRegistry({
    ...createSeoHandlers(context),
    ...createProductsHandlers(context),
    ...createEdmHandlers(context),
  });
  const api = createApiBridge({
    invoke: async (channel, ...args) => {
      const handler = registry.get(channel);
      if (!handler) throw new Error(`Missing IPC handler: ${channel}`);
      try {
        return await handler(...args);
      } catch (error) {
        throw serializeIpcError(error);
      }
    },
    listen: () => () => undefined,
  });
  return { api, methods, context };
}

describe("scenario query IPC", () => {
  it("forwards all nine read-only queries and preserves their result envelopes", async () => {
    const { api, methods, context } = setup();
    const candidateQuery = { limit: 12 };
    const gapQuery = { skus: [sku] };
    const safetyQuery = { skus: [sku], campaign_date: "2026-01-02" };

    await expect(api.seo.pageBrief?.(projectId, url)).resolves.toEqual(result);
    await expect(api.seo.issueCandidates?.(projectId, url)).resolves.toEqual(result);
    await expect(api.seo.internalLinkContext?.(projectId, url)).resolves.toEqual(result);
    await expect(api.products.skuBrief?.(projectId, sku)).resolves.toEqual(result);
    await expect(api.products.changes?.(projectId, sku)).resolves.toEqual(result);
    await expect(api.products.groupFamily?.(projectId, sku)).resolves.toEqual(result);
    await expect(api.edm.candidates?.(projectId, candidateQuery)).resolves.toEqual(result);
    await expect(api.edm.mediaGaps?.(projectId, gapQuery)).resolves.toEqual(result);
    await expect(api.edm.campaignSafety?.(projectId, safetyQuery)).resolves.toEqual(result);

    expect(methods.pageBrief).toHaveBeenCalledWith(projectId, url);
    expect(methods.issueCandidates).toHaveBeenCalledWith(projectId, url);
    expect(methods.internalLinkContext).toHaveBeenCalledWith(projectId, url);
    expect(methods.skuBrief).toHaveBeenCalledWith(projectId, sku);
    expect(methods.changes).toHaveBeenCalledWith(projectId, sku);
    expect(methods.groupFamily).toHaveBeenCalledWith(projectId, sku);
    expect(methods.candidates).toHaveBeenCalledWith(projectId, candidateQuery);
    expect(methods.mediaGaps).toHaveBeenCalledWith(projectId, gapQuery);
    expect(methods.campaignSafety).toHaveBeenCalledWith(projectId, safetyQuery);
    expect(context.withProject).toHaveBeenCalledTimes(9);
  });

  it("returns project and Core errors with code, message and detail", async () => {
    const { api, methods } = setup();
    await expect(api.seo.pageBrief?.("missing" as ProjectId, url)).rejects.toMatchObject({
      code: "PROJECT_NOT_FOUND",
      message: "项目不存在",
    });

    methods.candidates.mockRejectedValueOnce({ code: "CONFIG_INVALID", message: "查询参数无效", detail: "limit" });
    await expect(api.edm.candidates?.(projectId, { limit: 12 })).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      message: "查询参数无效",
      detail: "limit",
    });
  });
});
