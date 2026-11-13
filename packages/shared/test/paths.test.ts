import { describe, expect, it } from "vitest";
import {
  CSV_HEADERS,
  DEFAULT_WORKSPACE_FOLDERS,
  EXIT,
  PATHS,
  SCHEMA_VERSION,
  dailyReportFile,
  eventsFile,
  gradeDescriptionLength,
  gradeTitleLength,
  googleSiteSearchUrl,
  pathsFor,
} from "../src";

describe("shared contracts", () => {
  it("paths are project-relative POSIX paths", () => {
    for (const p of Object.values(PATHS)) {
      expect(p.startsWith("/")).toBe(false);
      expect(p.includes("\\")).toBe(false);
    }
    expect(eventsFile("2026-10")).toBe("index/inventory/events/2026-10.jsonl");
    expect(dailyReportFile("2026-10-22")).toMatch(/2026-10-22/);
  });

  it("keeps legacy paths intact and maps workspace data under _site-index", () => {
    const workspacePaths = pathsFor("workspace");

    expect(pathsFor("legacy")).toEqual(PATHS);
    expect(Object.keys(workspacePaths).sort()).toEqual(Object.keys(PATHS).sort());
    expect(workspacePaths.site).toBe("_site-index/site.json");
    expect(workspacePaths.skillsDir).toBe("_site-index/skills");
    expect(workspacePaths.skillsManifest).toBe("_site-index/skills/manifest.json");
    expect(workspacePaths.seoIssues).toBe("_site-index/seo/issues.jsonl");
    expect(pathsFor("legacy").gscSearchAnalytics).toBe("index/gsc/history.json");
    expect(workspacePaths.gscSearchAnalytics).toBe("_site-index/gsc/history.json");
    expect(workspacePaths.readme).toBe(PATHS.readme);
    expect(Object.values(workspacePaths).some((path) => path.startsWith("index/"))).toBe(false);
  });

  it("schema version and defaults", () => {
    expect(SCHEMA_VERSION).toBe("1.1");
    expect(DEFAULT_WORKSPACE_FOLDERS).toContain("seo");
    expect(CSV_HEADERS.skuMedia[0]).toBe("sku");
    expect(EXIT.NOT_RUNNER).toBe(5);
  });

  it("seo length grading", () => {
    expect(gradeTitleLength(45)).toBe("good");
    expect(gradeTitleLength(65)).toBe("fair");
    expect(gradeTitleLength(0)).toBe("poor");
    expect(gradeDescriptionLength(140)).toBe("good");
    expect(gradeDescriptionLength(90)).toBe("fair");
    expect(gradeDescriptionLength(300)).toBe("poor");
  });

  it("google site: url", () => {
    expect(googleSiteSearchUrl("https://www.example.com/p/a")).toBe(
      "https://www.google.com/search?q=site%3Awww.example.com%2Fp%2Fa",
    );
  });
});
