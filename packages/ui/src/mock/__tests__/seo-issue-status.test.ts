import type { ProjectId, SeoIssue } from "@siteindex/shared";
import { afterEach, describe, expect, it } from "vitest";
import { clone, projectSummaries, projectsChanged, seoIssues } from "../context";
import { createProjectsMock } from "../projects";
import { createSeoMock } from "../seo";

const originalStatuses = seoIssues.map((issue) => issue.status);
const originalDemoSummary = clone(projectSummaries.demo);
const originalDemo2Summary = clone(projectSummaries.demo2);

afterEach(() => {
  seoIssues.forEach((issue, index) => { issue.status = originalStatuses[index]!; });
  projectSummaries.demo = clone(originalDemoSummary);
  projectSummaries.demo2 = clone(originalDemo2Summary);
  projectsChanged.clear();
});

describe("SEO issue status mock", () => {
  it.each(["fixed", "ignored"] as const)("updates one %s issue and synchronizes the project attention count", async (status) => {
    const seo = createSeoMock();
    const projects = createProjectsMock();
    const changes: ProjectId[] = [];
    const unsubscribe = projects.onChanged((id) => changes.push(id));
    const beforeIssues = await seo.listIssues("demo", { page: 1, pageSize: 0, filters: { status: "open" } });
    const target: SeoIssue = beforeIssues.rows[0]!;
    const beforeSummary = await seo.summary("demo");
    const beforeProject = (await projects.list()).find(({ id }) => id === "demo")!;

    const result = await seo.setIssueStatus!("demo", { targets: [{ url: target.url, rule: target.rule }], status });

    expect(result.updated).toBe(1);
    const openIssues = await seo.listIssues("demo", { page: 1, pageSize: 0, filters: { status: "open" } });
    const updatedIssue = await seo.listIssues("demo", { page: 1, pageSize: 0, filters: { status } });
    const afterSummary = await seo.summary("demo");
    const afterProject = (await projects.list()).find(({ id }) => id === "demo")!;
    const beforeOpenCount = Number(beforeSummary.kpis.find(({ key }) => key === "issues")?.value);
    const afterOpenCount = Number(afterSummary.kpis.find(({ key }) => key === "issues")?.value);

    expect(openIssues.rows.some(({ url, rule }) => url === target.url && rule === target.rule)).toBe(false);
    expect(updatedIssue.rows).toContainEqual({ ...target, status });
    expect(openIssues.total).toBe(beforeIssues.total - 1);
    expect(afterOpenCount).toBe(beforeOpenCount - 1);
    expect(afterProject.attention).toBe(beforeProject.attention - 1);
    expect(changes).toContain("demo");
    unsubscribe();
  });
});
