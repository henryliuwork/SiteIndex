import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathsFor } from "@siteindex/shared";
import { afterEach, describe, expect, it } from "vitest";
import { syncProjectSearchAnalytics } from "../src";

const temporary: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("GSC project service", () => {
  it.each(["legacy", "workspace"] as const)("uses the %s project path and preserves history on failure", async (layout) => {
    const project = await mkdtemp(path.join(os.tmpdir(), "gsc-project-"));
    temporary.push(project);
    const paths = pathsFor(layout);
    await mkdir(path.dirname(path.join(project, paths.site)), { recursive: true });
    await writeFile(path.join(project, paths.site), "{}");
    let fail = false;
    const server = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => { body += chunk; });
      req.on("end", () => {
        const request = JSON.parse(body) as { dimensions: string[] };
        res.writeHead(fail ? 429 : 200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ rows: request.dimensions.length === 1
          ? [{ keys: ["2026-11-10"] }]
          : [{ keys: ["2026-11-10", "https://shop.example.test/a", "fictional"], clicks: 1, impressions: 3, ctr: 0.333, position: 2 }] }));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server unavailable");
    const options = { property: "https://shop.example.test/", accessToken: "synthetic-token", now: new Date("2026-11-13T12:00:00Z"), apiBaseUrl: `http://127.0.0.1:${address.port}` };
    const input = { mode: "initial_90_days" } as const;

    expect(await syncProjectSearchAnalytics(project, input, { ...options, property: null })).toMatchObject({ state: "blocked", error: { code: "GSC_PROPERTY_REQUIRED" } });
    expect(await syncProjectSearchAnalytics(project, input, options)).toMatchObject({ history_effect: "merged", records_written: 1 });
    const historyPath = path.join(project, paths.gscSearchAnalytics);
    const before = await readFile(historyPath, "utf8");
    expect(before).toContain("fictional");
    expect(before).not.toContain("synthetic-token");
    fail = true;
    expect(await syncProjectSearchAnalytics(project, input, options)).toMatchObject({ state: "failed", history_effect: "preserved" });
    expect(await readFile(historyPath, "utf8")).toBe(before);
  });
});
