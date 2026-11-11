import { pathsForProject } from "@siteindex/core";
import type { JobRequest } from "@siteindex/shared";
import { readFile } from "node:fs/promises";
import path from "node:path";

function localDate(timezone: string, now: Date): string {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(now)
      .map(({ type, value }) => [type, value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

export async function resolveJobRunId(
  request: Pick<JobRequest, "date" | "job" | "projectPath">,
  now = new Date(),
): Promise<string> {
  if (request.date) return `${request.date}-${request.job}`;
  try {
    const projectPath = path.resolve(request.projectPath);
    const projectPaths = await pathsForProject(projectPath);
    const content = await readFile(path.join(projectPath, projectPaths.site), "utf8");
    const config: unknown = JSON.parse(content);
    const timezone =
      typeof config === "object" &&
      config !== null &&
      !Array.isArray(config) &&
      "timezone" in config &&
      typeof config.timezone === "string"
        ? config.timezone
        : "UTC";
    return `${localDate(timezone, now)}-${request.job}`;
  } catch {
    return `${now.toISOString().slice(0, 10)}-${request.job}`;
  }
}
