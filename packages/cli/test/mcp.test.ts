import {
  InMemoryTransport,
  LATEST_PROTOCOL_VERSION,
  isJSONRPCResponse,
  parseJSONRPCMessage,
  type JSONRPCMessage,
} from "@modelcontextprotocol/server";
import { EXIT, type ProjectId, type ScenarioQueryResult } from "@siteindex/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/index";
import { createReadOnlyMcpServer, MCP_SCENARIO_TOOL_NAMES, type ScenarioMcpService } from "../src/mcp";

const PROJECT_ID = "mcp-selected-project" as ProjectId;
const SYNTHETIC_RESULT: ScenarioQueryResult<never> = {
  data: null,
  metadata: {
    sources: [{ kind: "synthetic.index", label: "Synthetic fixture" }],
    collected_at: "2026-11-12T08:30:00.000Z",
    missing_fields: [],
    quality: "complete",
    anomalies: [],
  },
};

const service: ScenarioMcpService = {
  seo: {
    pageBrief: vi.fn(async () => SYNTHETIC_RESULT),
    issueCandidates: vi.fn(async () => SYNTHETIC_RESULT),
    internalLinkContext: vi.fn(async () => SYNTHETIC_RESULT),
  },
  products: {
    skuBrief: vi.fn(async () => SYNTHETIC_RESULT),
    changes: vi.fn(async () => SYNTHETIC_RESULT),
    groupFamily: vi.fn(async () => SYNTHETIC_RESULT),
  },
  edm: {
    candidates: vi.fn(async () => SYNTHETIC_RESULT),
    mediaGaps: vi.fn(async () => SYNTHETIC_RESULT),
    campaignSafety: vi.fn(async () => SYNTHETIC_RESULT),
  },
};

const transports: InMemoryTransport[] = [];

afterEach(async () => {
  await Promise.all(transports.splice(0).map((transport) => transport.close()));
  vi.clearAllMocks();
});

function property(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function resultOf(message: JSONRPCMessage): unknown {
  if (!isJSONRPCResponse(message)) throw new Error("MCP request did not return a JSON-RPC response.");
  if ("error" in message) throw new Error(`MCP request failed: ${message.error.message}`);
  return message.result;
}

async function connectTestClient() {
  const server = createReadOnlyMcpServer(service, PROJECT_ID);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  transports.push(clientTransport, serverTransport);
  const pending = new Map<number, (message: JSONRPCMessage) => void>();
  let requestId = 0;
  clientTransport.onmessage = (message) => {
    if (!isJSONRPCResponse(message) || typeof message.id !== "number") return;
    pending.get(message.id)?.(message);
  };
  await server.connect(serverTransport);
  await clientTransport.start();

  const request = async (method: string, params: Record<string, unknown> = {}) => {
    const id = ++requestId;
    const response = new Promise<JSONRPCMessage>((resolve) => pending.set(id, resolve));
    await clientTransport.send(parseJSONRPCMessage({ jsonrpc: "2.0", id, method, params }));
    return response;
  };

  const initialize = await request("initialize", {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "synthetic-test-client", version: "1.0.0" },
  });
  expect(isJSONRPCResponse(initialize)).toBe(true);
  await clientTransport.send(parseJSONRPCMessage({ jsonrpc: "2.0", method: "notifications/initialized" }));
  return { request };
}

describe("read-only MCP scenario tools", () => {
  it("rejects write options and JSON wrapping before starting stdio", async () => {
    const io = { out: vi.fn(), err: vi.fn() };
    expect(await main(["mcp", "--project", "synthetic", "--allow-write"], io)).toBe(EXIT.BAD_ARGS);
    expect(await main(["mcp", "--json", "--project", "synthetic"], io)).toBe(EXIT.BAD_ARGS);
    expect(io.out).not.toHaveBeenCalled();
    expect(io.err).toHaveBeenCalledTimes(2);
  });

  it("serves exactly the nine scenario tools and returns their synthetic Core envelopes", async () => {
    const client = await connectTestClient();
    const listed = resultOf(await client.request("tools/list"));
    const tools = property(listed, "tools");
    expect(Array.isArray(tools) ? tools.map((tool) => property(tool, "name")) : null).toEqual([...MCP_SCENARIO_TOOL_NAMES]);

    const calls: { name: string; arguments: Record<string, unknown> }[] = [
      { name: "seo_page_brief", arguments: { url: "https://shop.example.test/demo-page" } },
      { name: "seo_issue_candidates", arguments: {} },
      { name: "seo_internal_link_context", arguments: { url: "https://shop.example.test/demo-page" } },
      { name: "product_sku_brief", arguments: { sku: "DEMO-001" } },
      { name: "product_changes", arguments: {} },
      { name: "product_group_family", arguments: { sku: "DEMO-001" } },
      { name: "edm_candidates", arguments: { stock: "any", parent_only: true, limit: 10 } },
      { name: "edm_media_gaps", arguments: { skus: ["DEMO-001"], stock: "any" } },
      { name: "edm_campaign_safety", arguments: { campaign_date: "2026-11-30", skus: ["DEMO-001"] } },
    ];

    for (const call of calls) {
      const result = resultOf(await client.request("tools/call", call));
      const content = property(result, "content");
      expect(Array.isArray(content) ? content[0] : null).toMatchObject({
        type: "text",
        text: JSON.stringify(SYNTHETIC_RESULT),
      });
      expect(property(result, "isError")).toBeUndefined();
    }

    expect(service.seo.pageBrief).toHaveBeenCalledWith(PROJECT_ID, "https://shop.example.test/demo-page");
    expect(service.seo.issueCandidates).toHaveBeenCalledWith(PROJECT_ID, undefined);
    expect(service.seo.internalLinkContext).toHaveBeenCalledWith(PROJECT_ID, "https://shop.example.test/demo-page");
    expect(service.products.skuBrief).toHaveBeenCalledWith(PROJECT_ID, "DEMO-001");
    expect(service.products.changes).toHaveBeenCalledWith(PROJECT_ID, undefined);
    expect(service.products.groupFamily).toHaveBeenCalledWith(PROJECT_ID, "DEMO-001");
    expect(service.edm.candidates).toHaveBeenCalledWith(PROJECT_ID, { stock: "any", parent_only: true, limit: 10 });
    expect(service.edm.mediaGaps).toHaveBeenCalledWith(PROJECT_ID, { skus: ["DEMO-001"], stock: "any" });
    expect(service.edm.campaignSafety).toHaveBeenCalledWith(PROJECT_ID, { campaign_date: "2026-11-30", skus: ["DEMO-001"] });
  });
});
