import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathsFor, type RunLog, type SeoIssue, type SeoLink, type SiteConfig } from "@siteindex/shared";
import { afterEach, describe, expect, it } from "vitest";
import { createCoreService } from "../src/service";

const TEMP_DIRS: string[] = [];
const DAY_MS = 24 * 60 * 60 * 1000;
const BASE_URL = "https://shop.example.test";
const TARGET_URL = `${BASE_URL}/synthetic-target`;

async function makeProject(layout: "legacy" | "workspace" = "legacy"): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-seo-scenarios-"));
  TEMP_DIRS.push(root);
  const projectPath = path.join(root, "synthetic-project");
  const paths = pathsFor(layout);
  await mkdir(path.join(projectPath, paths.index), { recursive: true });
  const config: Partial<SiteConfig> = {
    schema_version: "1.1",
    domain: "shop.example.test",
    base_url: BASE_URL,
    timezone: "UTC",
  };
  await writeFile(path.join(projectPath, paths.site), `${JSON.stringify(config)}\n`, "utf8");
  return projectPath;
}

function page(url: string, lastCrawled = new Date().toISOString().slice(0, 10)) {
  return {
    url,
    page_type: "page",
    status_code: 200,
    title: "Synthetic page",
    title_length: 14,
    meta_description: "Synthetic description",
    description_length: 22,
    h1: "Synthetic heading",
    h1_count: 1,
    canonical: url,
    canonical_status: "self",
    robots_meta: null,
    x_robots_tag: null,
    indexable: true,
    in_sitemap: true,
    schema_types: [],
    word_count: 24,
    last_crawled: lastCrawled,
  };
}

function issue(url: string, status: SeoIssue["status"] = "open"): SeoIssue {
  return {
    url,
    rule: "title_missing",
    severity: "mid",
    detail: "Synthetic issue",
    status,
    first_seen: "2026-11-01",
    last_seen: "2026-11-02",
  };
}

function link(from: string, to: string, anchor: string): SeoLink {
  return { from, to, anchor, to_type: "page", nofollow: false };
}

function weeklyRun(finishedAt: string): RunLog {
  return {
    run_id: "synthetic-weekly-run",
    job: "weekly",
    trigger: "manual",
    started_at: new Date(Date.parse(finishedAt) - 60_000).toISOString(),
    finished_at: finishedAt,
    status: "ok",
  };
}

async function writeRows(projectPath: string, layout: "legacy" | "workspace", key: "seoPages" | "seoIssues" | "seoLinks" | "runs", rows: readonly object[]): Promise<void> {
  const paths = pathsFor(layout);
  const filePath = path.join(projectPath, paths[key]);
  await mkdir(path.dirname(filePath), { recursive: true });
  const content = rows.map((row) => JSON.stringify(row)).join("\n");
  await writeFile(filePath, content ? `${content}\n` : "", "utf8");
}

function service(projectPath: string) {
  return createCoreService({
    resolveProject: () => projectPath,
    deviceId: "synthetic-test-device",
    cacheDir: path.join(path.dirname(projectPath), "cache"),
  });
}

async function writeCompleteScenario(projectPath: string, layout: "legacy" | "workspace", finishedAt = new Date().toISOString()): Promise<void> {
  const source = `${BASE_URL}/synthetic-source`;
  const other = `${BASE_URL}/synthetic-destination`;
  await Promise.all([
    writeRows(projectPath, layout, "seoPages", [page(TARGET_URL), page(source), page(other)]),
    writeRows(projectPath, layout, "seoIssues", [issue(TARGET_URL), issue(source, "fixed")]),
    writeRows(projectPath, layout, "seoLinks", [link(source, TARGET_URL, "target"), link(TARGET_URL, other, "destination")]),
    writeRows(projectPath, layout, "runs", [weeklyRun(finishedAt)]),
  ]);
}

afterEach(async () => {
  await Promise.all(TEMP_DIRS.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("SEO scenario queries", () => {
  it.each(["legacy", "workspace"] as const)("returns stored page, issue and link records from %s layout", async (layout) => {
    const projectPath = await makeProject(layout);
    const finishedAt = new Date().toISOString();
    await writeCompleteScenario(projectPath, layout, finishedAt);
    const api = service(projectPath);

    const [brief, candidates, allCandidates, context] = await Promise.all([
      api.seo.pageBrief!("fixture", TARGET_URL),
      api.seo.issueCandidates!("fixture", TARGET_URL),
      api.seo.issueCandidates!("fixture"),
      api.seo.internalLinkContext!("fixture", TARGET_URL),
    ]);

    expect(brief.data).toMatchObject({
      page: { url: TARGET_URL },
      issues: [{ url: TARGET_URL, status: "open" }],
      incoming_links: [{ from: `${BASE_URL}/synthetic-source`, to: TARGET_URL }],
      outgoing_links: [{ from: TARGET_URL, to: `${BASE_URL}/synthetic-destination` }],
    });
    expect(candidates.data).toEqual([issue(TARGET_URL)]);
    expect(allCandidates.data).toEqual([issue(TARGET_URL)]);
    expect(context.data).toMatchObject({
      page: { url: TARGET_URL },
      incoming_links: [{ source_page: { url: `${BASE_URL}/synthetic-source` } }],
      outgoing_links: [{ target_page: { url: `${BASE_URL}/synthetic-destination` } }],
    });
    for (const result of [brief, candidates, allCandidates, context]) {
      expect(result.metadata).toMatchObject({
        collected_at: finishedAt,
        missing_fields: [],
        quality: "complete",
        anomalies: [],
      });
      expect(result.metadata.sources.map((source) => source.kind)).toContain("logs.runs");
    }

    const notIndexed = await api.seo.pageBrief!("fixture", `${BASE_URL}/not-indexed`);
    expect(notIndexed.data).toBeNull();
    expect(notIndexed.metadata.missing_fields).toContain("seo.pages.url");
    expect(notIndexed.metadata.anomalies).toContainEqual(expect.objectContaining({ code: "PAGE_NOT_INDEXED" }));
  });

  it("reports missing index files and an unindexed URL without throwing", async () => {
    const projectPath = await makeProject();
    const api = service(projectPath);

    const [brief, candidates, context] = await Promise.all([
      api.seo.pageBrief!("fixture", TARGET_URL),
      api.seo.issueCandidates!("fixture"),
      api.seo.internalLinkContext!("fixture", TARGET_URL),
    ]);

    expect(brief.data).toBeNull();
    expect(candidates.data).toBeNull();
    expect(context.data).toBeNull();
    expect(brief.metadata).toMatchObject({
      collected_at: null,
      quality: "partial",
      missing_fields: expect.arrayContaining(["seo.pages", "seo.issues", "seo.links", "logs.runs"]),
    });
    expect(brief.metadata.anomalies).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "SOURCE_MISSING", field: "seo.pages" }),
      expect.objectContaining({ code: "SOURCE_MISSING", field: "logs.runs" }),
    ]));
    expect(JSON.stringify(brief.metadata)).not.toContain(projectPath);
  });

  it("marks a corrupt source as unreliable and keeps other readable page data", async () => {
    const projectPath = await makeProject();
    await writeRows(projectPath, "legacy", "seoPages", [page(TARGET_URL)]);
    await writeRows(projectPath, "legacy", "seoLinks", []);
    await writeRows(projectPath, "legacy", "runs", [weeklyRun(new Date().toISOString())]);
    const paths = pathsFor("legacy");
    const issuePath = path.join(projectPath, paths.seoIssues);
    await mkdir(path.dirname(issuePath), { recursive: true });
    await writeFile(issuePath, "{invalid json\n", "utf8");
    const api = service(projectPath);

    const brief = await api.seo.pageBrief!("fixture", TARGET_URL);
    const candidates = await api.seo.issueCandidates!("fixture");

    expect(brief.data).toMatchObject({ page: { url: TARGET_URL }, issues: [] });
    expect(brief.metadata.quality).toBe("unreliable");
    expect(brief.metadata.anomalies).toContainEqual(expect.objectContaining({ code: "SOURCE_INVALID", field: "seo.issues" }));
    expect(candidates.data).toBeNull();
    expect(candidates.metadata.quality).toBe("unreliable");
  });

  it("reports dangling link endpoints and stale weekly collection timestamps", async () => {
    const projectPath = await makeProject();
    const oldFinishedAt = new Date(Date.now() - 15 * DAY_MS).toISOString();
    await Promise.all([
      writeRows(projectPath, "legacy", "seoPages", [page(TARGET_URL)]),
      writeRows(projectPath, "legacy", "seoIssues", []),
      writeRows(projectPath, "legacy", "seoLinks", [link(`${BASE_URL}/missing-source`, TARGET_URL, "in"), link(TARGET_URL, `${BASE_URL}/missing-target`, "out")]),
      writeRows(projectPath, "legacy", "runs", [weeklyRun(oldFinishedAt)]),
    ]);
    const api = service(projectPath);

    const [brief, context] = await Promise.all([
      api.seo.pageBrief!("fixture", TARGET_URL),
      api.seo.internalLinkContext!("fixture", TARGET_URL),
    ]);

    expect(brief.metadata.collected_at).toBe(oldFinishedAt);
    expect(brief.metadata.anomalies).toContainEqual(expect.objectContaining({ code: "SEO_INDEX_STALE" }));
    expect(context.data).toMatchObject({
      incoming_links: [{ source_page: null }],
      outgoing_links: [{ target_page: null }],
    });
    expect(context.metadata.missing_fields).toContain("seo.pages.link_endpoints");
    expect(context.metadata.anomalies).toContainEqual(expect.objectContaining({ code: "LINK_ENDPOINT_NOT_INDEXED" }));
  });
});
