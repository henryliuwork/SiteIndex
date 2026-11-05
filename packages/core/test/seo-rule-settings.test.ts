import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SEO_RULE_LABELS, PATHS, type SeoIssue, type SiteConfig } from "@siteindex/shared";
import { afterEach, describe, expect, it } from "vitest";
import { compareKeys } from "../src/io/compare";
import { writeJsonl } from "../src/io/jsonl";
import { createCoreService } from "../src/service";

const TEMP_DIRS: string[] = [];

async function makeProject(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "siteindex-seo-rule-settings-"));
  TEMP_DIRS.push(root);
  const projectPath = path.join(root, "project");
  await mkdir(path.join(projectPath, "index", "seo"), { recursive: true });

  const config: Pick<SiteConfig, "schema_version" | "domain" | "base_url" | "timezone" | "seo"> = {
    schema_version: "1.0",
    domain: "shop.example.test",
    base_url: "https://shop.example.test",
    timezone: "UTC",
    seo: {
      ignore_rules: [
        { rule: "noindex" },
        { rule: "noindex", url: "https://shop.example.test/noindex-b" },
        { rule: "title_length", url: "https://shop.example.test/legacy-title" },
        { rule: "title_length", url: "https://shop.example.test/legacy-title" },
      ],
    },
  };
  await writeFile(path.join(projectPath, PATHS.site), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return projectPath;
}

function issue(url: string, rule: SeoIssue["rule"], status: SeoIssue["status"]): SeoIssue {
  return {
    url: `https://shop.example.test/${url}`,
    rule,
    severity: "mid",
    detail: "虚构 SEO 问题",
    status,
    first_seen: "2026-11-01",
    last_seen: "2026-11-01",
  };
}

afterEach(async () => {
  await Promise.all(TEMP_DIRS.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("seo.getRuleSettings", () => {
  it("returns every rule with stable metadata, open counts and configured ignores", async () => {
    const projectPath = await makeProject();
    await writeJsonl(path.join(projectPath, PATHS.seoIssues), [
      issue("noindex-a", "noindex", "open"),
      issue("noindex-b", "noindex", "ignored"),
      issue("duplicate-a", "title_duplicate", "open"),
      issue("legacy-title", "title_length", "open"),
      issue("description", "desc_length", "fixed"),
    ].map((row) => ({ ...row })), "seo_issue");

    const api = createCoreService({
      resolveProject: (id) => id === "fixture" ? projectPath : path.join(projectPath, "missing"),
      deviceId: "test-device",
      cacheDir: path.join(path.dirname(projectPath), "cache"),
    });
    const settings = await api.seo.getRuleSettings("fixture");

    expect(settings.map((row) => row.rule)).toEqual(Object.keys(SEO_RULE_LABELS).sort(compareKeys));
    expect(settings.every((row) => row.name === SEO_RULE_LABELS[row.rule] && row.description.length > 0)).toBe(true);
    expect(settings.find((row) => row.rule === "noindex")).toMatchObject({
      severity: "low",
      pending_count: 1,
      ignored: true,
      ignored_urls: ["https://shop.example.test/noindex-b"],
    });
    expect(settings.find((row) => row.rule === "title_length")).toMatchObject({
      severity: "low",
      pending_count: 1,
      ignored: false,
      ignored_urls: ["https://shop.example.test/legacy-title"],
    });
    expect(settings.find((row) => row.rule === "title_duplicate")?.pending_count).toBe(1);
    expect(settings.find((row) => row.rule === "desc_length")?.pending_count).toBe(0);
    expect(settings.find((row) => row.rule === "http_4xx")?.pending_count).toBe(0);
  });
});