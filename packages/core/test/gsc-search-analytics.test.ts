import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { syncSearchAnalytics } from "../src/gsc/search-analytics";

const temporary: string[] = [];
const servers: Server[] = [];
const today = new Date("2026-11-13T12:00:00Z");
const property = "https://store.example.test/";

async function fixture(layout: "legacy" | "workspace") {
  const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-gsc-"));
  temporary.push(root);
  const dir = path.join(root, layout === "legacy" ? "index" : "_site-index", "gsc");
  await mkdir(dir, { recursive: true });
  return path.join(dir, "history.json");
}

async function serverFor(handler: (body: { dimensions: string[]; startDate: string; endDate: string; startRow: number }) => { status?: number; data?: unknown }) {
  const requests: Array<{ dimensions: string[]; startDate: string; endDate: string; startRow: number }> = [];
  const server = createServer((req, res) => {
    let text = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => { text += chunk; });
    req.on("end", () => {
      const body = JSON.parse(text) as (typeof requests)[number];
      requests.push(body);
      const answer = handler(body);
      res.writeHead(answer.status ?? 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(answer.data ?? {}));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server unavailable");
  return { requests, apiBaseUrl: `http://127.0.0.1:${address.port}` };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("GSC Search Analytics local sync", () => {
  it.each(["legacy", "workspace"] as const)("imports 90 days and incrementally merges real metrics in %s layout", async (layout) => {
    const historyPath = await fixture(layout);
    let date = "2026-11-10";
    const mock = await serverFor((body) => body.dimensions.length === 1
      ? { data: { rows: [{ keys: [date] }] } }
      : { data: { rows: [{ keys: [date, "https://store.example.test/item", "demo query"], clicks: 3, impressions: 20, ctr: 0.15, position: 4.5 }] } });
    const options = { historyPath, property, accessToken: "synthetic-token", now: today, apiBaseUrl: mock.apiBaseUrl };

    const first = await syncSearchAnalytics({ mode: "initial_90_days" }, options);
    expect(first.state).toBe("partial");
    expect(first.metadata.requested_range).toEqual({ start_date: "2026-08-13", end_date: "2026-11-10" });
    expect(first.records_written).toBe(1);
    expect(mock.requests[1]?.dimensions).toEqual(["date", "page", "query"]);
    date = "2026-11-11";
    const second = await syncSearchAnalytics({ mode: "incremental" }, options);
    expect(second.metadata.requested_range).toEqual({ start_date: "2026-11-11", end_date: "2026-11-11" });
    const stored = JSON.parse(await readFile(historyPath, "utf8")) as { rows: Array<{ date: string; impressions: number; ctr: number }> };
    expect(stored.rows.map((row) => row.date)).toEqual(["2026-11-10", "2026-11-11"]);
    expect(stored.rows[0]).toMatchObject({ impressions: 20, ctr: 0.15, collected_at: today.toISOString() });
    expect(await readFile(historyPath, "utf8")).not.toContain("synthetic-token");
  });

  it("keeps existing bytes unchanged when dates or detailed rows are empty", async () => {
    const historyPath = await fixture("legacy");
    let empty = false;
    const mock = await serverFor((body) => body.dimensions.length === 1
      ? { data: { rows: [{ keys: ["2026-11-10"] }] } }
      : empty ? { data: {} } : { data: { rows: [{ keys: ["2026-11-10", "https://store.example.test/a", "demo"], clicks: 1, impressions: 3, ctr: 0.333, position: 2 }] } });
    const options = { historyPath, property, accessToken: "synthetic-token", now: today, apiBaseUrl: mock.apiBaseUrl };
    await syncSearchAnalytics({ mode: "initial_90_days" }, options);
    const before = await readFile(historyPath, "utf8");
    empty = true;
    const result = await syncSearchAnalytics({ mode: "initial_90_days" }, options);
    expect(result).toMatchObject({ state: "blocked", history_effect: "preserved", error: { code: "GSC_NO_ROWS" } });
    expect(await readFile(historyPath, "utf8")).toBe(before);
  });

  it("reports a date missing from detailed rows without removing its existing history", async () => {
    const historyPath = await fixture("legacy");
    let partial = false;
    const mock = await serverFor((body) => body.dimensions.length === 1
      ? { data: { rows: [{ keys: ["2026-11-10"] }, { keys: ["2026-11-11"] }] } }
      : { data: { rows: (partial ? ["2026-11-11"] : ["2026-11-10", "2026-11-11"]).map((date) => ({ keys: [date, "https://store.example.test/a", "demo"], clicks: 1, impressions: 3, ctr: 0.333, position: 2 })) } });
    const options = { historyPath, property, accessToken: "synthetic-token", now: today, apiBaseUrl: mock.apiBaseUrl };
    await syncSearchAnalytics({ mode: "initial_90_days" }, options);
    partial = true;
    const result = await syncSearchAnalytics({ mode: "initial_90_days" }, options);
    expect(result.state).toBe("partial");
    expect(result.metadata.missing_ranges).toContainEqual({ start_date: "2026-11-10", end_date: "2026-11-10", reason: "not_returned" });
    const stored = JSON.parse(await readFile(historyPath, "utf8")) as { rows: Array<{ date: string }> };
    expect(stored.rows.map((row) => row.date)).toEqual(["2026-11-10", "2026-11-11"]);
  });

  it.each([403, 429, 500])("preserves existing history when HTTP %s interrupts sync", async (status) => {
    const historyPath = await fixture("workspace");
    let failing = false;
    const mock = await serverFor((body) => failing ? { status } : body.dimensions.length === 1
      ? { data: { rows: [{ keys: ["2026-11-10"] }] } }
      : { data: { rows: [{ keys: ["2026-11-10", "https://store.example.test/a", "demo"], clicks: 1, impressions: 3, ctr: 0.333, position: 2 }] } });
    const options = { historyPath, property, accessToken: "synthetic-token", now: today, apiBaseUrl: mock.apiBaseUrl };
    await syncSearchAnalytics({ mode: "initial_90_days" }, options);
    const before = await readFile(historyPath, "utf8");
    failing = true;
    const result = await syncSearchAnalytics({ mode: "initial_90_days" }, options);
    expect(result).toMatchObject({ state: "failed", history_effect: "preserved" });
    expect(await readFile(historyPath, "utf8")).toBe(before);
  });

  it("preserves history for an empty availability response and a network failure", async () => {
    const historyPath = await fixture("legacy");
    let empty = false;
    const mock = await serverFor((body) => empty ? { data: {} } : body.dimensions.length === 1
      ? { data: { rows: [{ keys: ["2026-11-10"] }] } }
      : { data: { rows: [{ keys: ["2026-11-10", "https://store.example.test/a", "demo"], clicks: 1, impressions: 3, ctr: 0.333, position: 2 }] } });
    const options = { historyPath, property, accessToken: "synthetic-token", now: today, apiBaseUrl: mock.apiBaseUrl };
    await syncSearchAnalytics({ mode: "initial_90_days" }, options);
    const before = await readFile(historyPath, "utf8");
    empty = true;
    expect(await syncSearchAnalytics({ mode: "initial_90_days" }, options)).toMatchObject({ state: "blocked", history_effect: "preserved", error: { code: "GSC_NO_DATA" } });
    expect(await syncSearchAnalytics({ mode: "initial_90_days" }, { ...options, fetch: async () => { throw new Error("network unavailable"); } })).toMatchObject({ state: "failed", history_effect: "preserved" });
    expect(await readFile(historyPath, "utf8")).toBe(before);
  });

  it("keeps history if availability succeeds but the detailed request is rate limited", async () => {
    const historyPath = await fixture("workspace");
    let failDetails = false;
    const mock = await serverFor((body) => body.dimensions.length === 1
      ? { data: { rows: [{ keys: ["2026-11-10"] }] } }
      : failDetails ? { status: 429 } : { data: { rows: [{ keys: ["2026-11-10", "https://store.example.test/a", "demo"], clicks: 1, impressions: 3, ctr: 0.333, position: 2 }] } });
    const options = { historyPath, property, accessToken: "synthetic-token", now: today, apiBaseUrl: mock.apiBaseUrl };
    await syncSearchAnalytics({ mode: "initial_90_days" }, options);
    const before = await readFile(historyPath, "utf8");
    failDetails = true;
    expect(await syncSearchAnalytics({ mode: "initial_90_days" }, options)).toMatchObject({ state: "failed", history_effect: "preserved", error: { code: "GSC_QUOTA_OR_PERMISSION" } });
    expect(await readFile(historyPath, "utf8")).toBe(before);
  });
});
