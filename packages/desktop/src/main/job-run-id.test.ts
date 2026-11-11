import { pathsFor, type ProjectLayout } from "@siteindex/shared";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveJobRunId } from "./job-run-id.js";

const roots: string[] = [];

async function fixtureProject(layout: ProjectLayout): Promise<string> {
  const projectPath = await mkdtemp(path.join(tmpdir(), "siteindex-job-run-id-"));
  roots.push(projectPath);
  const paths = pathsFor(layout);
  await mkdir(path.dirname(path.join(projectPath, paths.site)), { recursive: true });
  await writeFile(path.join(projectPath, paths.site), JSON.stringify({ timezone: "America/Los_Angeles" }), "utf8");
  return projectPath;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Desktop Job run id layout resolution", () => {
  it.each(["legacy", "workspace"] as const)("uses the %s site config timezone", async (layout) => {
    const projectPath = await fixtureProject(layout);

    await expect(resolveJobRunId({ projectPath, job: "media" }, new Date("2026-11-11T01:00:00.000Z"))).resolves.toBe(
      "2026-11-10-media",
    );
  });

  it("uses the supplied business date without reading the project layout", async () => {
    await expect(
      resolveJobRunId({
        projectPath: path.join(tmpdir(), "missing-siteindex-project"),
        job: "media",
        date: "2026-11-09",
      }),
    ).resolves.toBe("2026-11-09-media");
  });
});
