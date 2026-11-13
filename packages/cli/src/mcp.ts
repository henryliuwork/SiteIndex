import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { ProjectId } from "@siteindex/shared";
import * as z from "zod/v4";
import type { CoreService } from "@siteindex/core";

export const MCP_SCENARIO_TOOL_NAMES = [
  "seo_page_brief",
  "seo_issue_candidates",
  "seo_internal_link_context",
  "product_sku_brief",
  "product_changes",
  "product_group_family",
  "edm_candidates",
  "edm_media_gaps",
  "edm_campaign_safety",
] as const;

export type ScenarioMcpService = {
  seo: Pick<CoreService["seo"], "pageBrief" | "issueCandidates" | "internalLinkContext">;
  products: Pick<CoreService["products"], "skuBrief" | "changes" | "groupFamily">;
  edm: Pick<CoreService["edm"], "candidates" | "mediaGaps" | "campaignSafety">;
};

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") return error.code;
  return "QUERY_FAILED";
}

function unavailableMethod() {
  return Object.assign(new Error("当前 Core 不支持该场景查询。"), { code: "CORE_METHOD_UNAVAILABLE" });
}

function response(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

async function readOnlyResponse(work: () => Promise<unknown>) {
  try {
    return response(await work());
  } catch (error) {
    return {
      ...response({ error: { code: errorCode(error), message: "本地只读查询未能完成。" } }),
      isError: true,
    };
  }
}

/** Only registers deterministic reads. Mutation, job, media and export tools are deliberately absent. */
export function createReadOnlyMcpServer(service: ScenarioMcpService, projectId: ProjectId): McpServer {
  const server = new McpServer({ name: "siteindex", version: "0.5.2" });

  server.registerTool("seo_page_brief", {
    description: "读取指定页面的本地 SEO 摘要与来源元数据。只读，不抓取页面。",
    inputSchema: z.object({ url: z.string().min(1).describe("索引中的页面 URL") }),
  }, async ({ url }) => readOnlyResponse(() => {
    if (!service.seo.pageBrief) throw unavailableMethod();
    return service.seo.pageBrief(projectId, url);
  }));

  server.registerTool("seo_issue_candidates", {
    description: "读取本地 SEO 问题候选；可按页面 URL 限定。返回数据与来源元数据。",
    inputSchema: z.object({ url: z.string().min(1).optional().describe("可选的页面 URL") }),
  }, async ({ url }) => readOnlyResponse(() => {
    if (!service.seo.issueCandidates) throw unavailableMethod();
    return service.seo.issueCandidates(projectId, url);
  }));

  server.registerTool("seo_internal_link_context", {
    description: "读取指定页面的本地内链上下文与来源元数据。只读，不抓取页面。",
    inputSchema: z.object({ url: z.string().min(1).describe("索引中的页面 URL") }),
  }, async ({ url }) => readOnlyResponse(() => {
    if (!service.seo.internalLinkContext) throw unavailableMethod();
    return service.seo.internalLinkContext(projectId, url);
  }));

  server.registerTool("product_sku_brief", {
    description: "读取一个真实 feed SKU 的本地商品、库存和来源摘要。",
    inputSchema: z.object({ sku: z.string().min(1).describe("真实 feed SKU") }),
  }, async ({ sku }) => readOnlyResponse(() => service.products.skuBrief(projectId, sku)));

  server.registerTool("product_changes", {
    description: "读取本地商品变化记录；可按 SKU 限定，不传 SKU 时读取项目级变化。",
    inputSchema: z.object({ sku: z.string().min(1).optional().describe("可选的真实 feed SKU") }),
  }, async ({ sku }) => readOnlyResponse(() => service.products.changes(projectId, sku)));

  server.registerTool("product_group_family", {
    description: "读取指定真实 feed SKU 所属的本地父子 SKU 家族。",
    inputSchema: z.object({ sku: z.string().min(1).describe("真实 feed SKU") }),
  }, async ({ sku }) => readOnlyResponse(() => service.products.groupFamily(projectId, sku)));

  server.registerTool("edm_candidates", {
    description: "读取按库存、分类、标签和 EDM 排除标记筛选的本地商品事实；不排序、不联网。",
    inputSchema: z.object({
      category: z.string().min(1).optional(),
      tag: z.string().min(1).optional(),
      stock: z.enum(["in_stock", "any"]).optional(),
      parent_only: z.boolean().optional(),
      include_excluded: z.boolean().optional(),
      limit: z.number().int().nonnegative().optional(),
    }),
  }, async (query) => readOnlyResponse(() => service.edm.candidates(projectId, query)));

  server.registerTool("edm_media_gaps", {
    description: "读取本地缺图或仅有不兼容图片格式的 SKU；不会请求图片 URL。",
    inputSchema: z.object({
      skus: z.array(z.string().min(1)).optional(),
      stock: z.enum(["in_stock", "any"]).optional(),
      parent_only: z.boolean().optional(),
      limit: z.number().int().nonnegative().optional(),
    }),
  }, async (query) => readOnlyResponse(() => service.edm.mediaGaps(projectId, query)));

  server.registerTool("edm_campaign_safety", {
    description: "按指定活动日期检查本地 SKU 库存、图片、排除标记、折扣、币种和冷却期；不发送 EDM。",
    inputSchema: z.object({
      campaign_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
      skus: z.array(z.string().min(1)).min(1),
    }),
  }, async (query) => readOnlyResponse(() => service.edm.campaignSafety(projectId, query)));

  return server;
}

/** Starts the stdio-only read-only MCP server. No log is written to stdout. */
export function serveReadOnlyMcp(service: ScenarioMcpService, projectId: ProjectId): void {
  serveStdio(() => createReadOnlyMcpServer(service, projectId));
}
