import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PATHS } from "@siteindex/shared";
import { describe, expect, it } from "vitest";
import { createCoreService } from "../src/service";

const fixture = path.resolve(process.cwd(), "fixtures/expected/project");

describe("project sync summary", () => {
  it("keeps sync never after a validate-only run and ignores newer local jobs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-sync-summary-"));
    try {
      const project = path.join(root, "demo-project");
      await cp(fixture, project, { recursive: true });
      const runsPath = path.join(project, PATHS.runs);
      await writeFile(runsPath, "");
      const api = createCoreService({
        resolveProject: () => project, deviceId: "test-device", cacheDir: path.join(root, "cache"),
      });
      await api.runJob({ projectPath: project, job: "validate", trigger: "manual" }, () => undefined);
      expect((await api.projects.get("demo")).summary.sync).toEqual({ state: "never", at: null, job: null });

      const validationRun = await readFile(runsPath, "utf8");
      const daily = {
        run_id: "2026-10-21-daily", job: "daily", started_at: "2026-10-21T09:00:00Z",
        finished_at: "2026-10-21T09:01:00Z", status: "ok",
      };
      await writeFile(runsPath, JSON.stringify(daily) + "\n" + validationRun);
      api.invalidate(project);
      expect((await api.projects.get("demo")).summary.sync).toEqual({
        state: "ok", at: daily.finished_at, job: "daily",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
