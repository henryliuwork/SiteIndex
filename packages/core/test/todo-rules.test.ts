import { describe, expect, it } from "vitest";
import type { PathKey, TodoRuleSourceReference } from "@siteindex/shared";
import { compareKeys } from "../src/io/compare";
import {
  generateTodoRuleFindings,
  type TodoRuleEdmCandidate,
  type TodoRuleGenerationInput,
  type TodoRuleSnapshot,
} from "../src/todos/rule-generation";

const OBSERVED_AT = "2026-11-15T12:00:00Z";
const COLLECTED_AT = "2026-11-15T11:30:00Z";
type SeoRow = TodoRuleGenerationInput["seo_issues"]["rows"][number];
type SkuRow = TodoRuleGenerationInput["skus"]["rows"][number];
type StockRow = TodoRuleGenerationInput["inventory_latest"]["rows"][number];
type EventRow = TodoRuleGenerationInput["inventory_events"]["rows"][number];
type SiteRow = TodoRuleGenerationInput["site"]["rows"][number];
type EdmRow = TodoRuleEdmCandidate["candidate"];
type RunRow = TodoRuleGenerationInput["runs"]["rows"][number];

function snapshot<T>(
  rows: readonly T[],
  collectedAt: string | null = COLLECTED_AT,
  status: TodoRuleSnapshot<T>["status"] = "complete",
): TodoRuleSnapshot<T> {
  return { status, collected_at: collectedAt, rows };
}

function source(path: PathKey, recordKey: string, collectedAt = COLLECTED_AT): TodoRuleSourceReference {
  return { path, record_key: recordKey, collected_at: collectedAt };
}

function seoIssue(
  url = "https://shop.example.test/products/demo",
  rule: SeoRow["rule"] = "http_4xx",
  detail = "页面返回 404。",
  severity: SeoRow["severity"] = "high",
  status: SeoRow["status"] = "open",
): SeoRow {
  return {
    url,
    rule,
    severity,
    detail,
    status,
  };
}

function sku(skuId: string, lastSeen = "2026-11-15"): SkuRow {
  return { sku: skuId, status: "active", last_seen: lastSeen };
}

function latest(skuId: string, stockStatus: StockRow["stock_status"] = "in_stock"): StockRow {
  return { sku: skuId, stock_status: stockStatus };
}

function event(skuId: string, date = "2026-11-10"): EventRow {
  return { date, sku: skuId, type: "feed_anomaly" };
}

function edmCandidate(skuId: string, overrides: Partial<EdmRow> = {}): EdmRow {
  return {
    sku: skuId,
    stock_status: "in_stock",
    exclude_edm: false,
    image_url: null,
    image_source: "none",
    ...overrides,
  };
}

function candidateRow(
  skuId: string,
  sources: TodoRuleSourceReference[],
  overrides: Partial<EdmRow> = {},
): TodoRuleEdmCandidate {
  return { candidate: edmCandidate(skuId, overrides), sources };
}

function run(
  run_id: string,
  job: RunRow["job"],
  started_at: string,
  finished_at: string,
  status: RunRow["status"],
): RunRow {
  return { run_id, job, started_at, finished_at, status };
}

function emptyInput(): TodoRuleGenerationInput {
  return {
    observed_at: OBSERVED_AT,
    seo_issues: snapshot<SeoRow>([]),
    skus: snapshot<SkuRow>([]),
    inventory_latest: snapshot<StockRow>([]),
    inventory_events: snapshot<EventRow>([]),
    site: snapshot<SiteRow>([{ sku_grouping: { enabled: false, rule: { type: "suffix", value: "-child" } } }]),
    edm_candidates: snapshot<TodoRuleEdmCandidate>([]),
    runs: snapshot<RunRow>([]),
  };
}

describe("generateTodoRuleFindings", () => {
  it("generates traceable findings for SEO, inventory, EDM, and sync rules", () => {
    const input = emptyInput();
    input.seo_issues.rows = [
      seoIssue(),
      seoIssue("https://shop.example.test/products/demo", "http_4xx", "重复读取的同一问题。"),
      seoIssue("https://shop.example.test/products/title", "title_missing", "页面标题为空。", "mid"),
      seoIssue("https://shop.example.test/products/schema", "schema_missing", "缺少 Product schema。", "mid"),
      seoIssue("https://shop.example.test/products/orphan", "orphan", "没有站内入链。", "low"),
      seoIssue("https://shop.example.test/products/fixed", "http_4xx", "页面返回 404。", "high", "fixed"),
      seoIssue("https://shop.example.test/products/ignored", "http_4xx", "页面返回 404。", "high", "ignored"),
    ];
    input.skus.rows = [
      sku("DEMO-PARENT"),
      sku("DEMO-PARENT-child-01"),
      sku("DEMO-PARENT-child-02"),
      sku("DEMO-UNKNOWN"),
      sku("DEMO-RESTORED"),
    ];
    input.inventory_latest.rows = [
      latest("DEMO-PARENT"),
      latest("DEMO-PARENT-child-01"),
      latest("DEMO-PARENT-child-02"),
      latest("DEMO-UNKNOWN", "unknown"),
      latest("DEMO-RESTORED"),
    ];
    input.inventory_events.rows = [event("DEMO-ANOMALY"), event("DEMO-RESTORED")];
    input.site.rows = [{ sku_grouping: { enabled: true, rule: { type: "suffix", value: "-child-01" } } }];
    input.edm_candidates.rows = [
      candidateRow("DEMO-EDM", [source("skus", "DEMO-EDM"), source("skuStockView", "DEMO-EDM")]),
      candidateRow("DEMO-EXCLUDED", [source("skus", "DEMO-EXCLUDED")], { exclude_edm: true }),
      candidateRow("DEMO-OOS", [source("skus", "DEMO-OOS")], { stock_status: "out_of_stock" }),
      candidateRow("DEMO-HAS-IMAGE", [source("skus", "DEMO-HAS-IMAGE")], {
        image_url: "https://img.example.test/demo.jpg",
        image_source: "feed",
      }),
    ];
    input.runs.rows = [
      run("daily-old-ok", "daily", "2026-11-13T00:00:00Z", "2026-11-13T00:10:00Z", "ok"),
      run("daily-latest-failed", "daily", "2026-11-15T10:00:00Z", "2026-11-15T10:02:00Z", "failed"),
      run("weekly-old-ok", "weekly", "2026-10-30T00:00:00Z", "2026-10-30T00:10:00Z", "ok"),
    ];

    const result = generateTodoRuleFindings(input);
    const byRule = new Map(result.findings.map((finding) => [finding.rule_id, finding]));

    expect(result.scan).toEqual({ status: "complete", evaluated_at: OBSERVED_AT });
    expect(result.findings.filter((finding) => finding.rule_id === "seo.issue.http_4xx")).toHaveLength(1);
    expect(result.findings.map((finding) => finding.rule_id)).toEqual(
      expect.arrayContaining([
        "seo.issue.http_4xx",
        "seo.issue.schema_missing",
        "seo.issue.orphan",
        "inventory.unknown_stock",
        "inventory.feed_anomaly",
        "inventory.sku_grouping_collision",
        "edm.promotable_missing_usable_image",
        "sync.latest_run_failed",
        "sync.data_stale",
      ]),
    );
    expect(
      result.findings.some(
        (finding) => finding.subject.key === "DEMO-RESTORED" && finding.rule_id === "inventory.feed_anomaly",
      ),
    ).toBe(false);
    expect(
      result.findings.some(
        (finding) =>
          finding.subject.key === "DEMO-EXCLUDED" ||
          finding.subject.key === "DEMO-OOS" ||
          finding.subject.key === "DEMO-HAS-IMAGE",
      ),
    ).toBe(false);
    expect(byRule.get("inventory.sku_grouping_collision")?.subject.key).toBe("DEMO-PARENT");
    expect(byRule.get("inventory.unknown_stock")?.subject.key).toBe("DEMO-UNKNOWN");
    expect(byRule.get("edm.promotable_missing_usable_image")?.subject.key).toBe("DEMO-EDM");
    expect(byRule.get("sync.latest_run_failed")?.subject.key).toBe("daily");
    expect(
      result.findings.some((finding) => finding.rule_id === "sync.data_stale" && finding.subject.key === "weekly"),
    ).toBe(true);
    for (const finding of result.findings) {
      expect(finding.dedupe_key).toMatch(/^todo:v1:[a-f0-9]{64}$/);
      expect(finding.sources.length).toBeGreaterThan(0);
      expect(finding.sources).toEqual(
        [...finding.sources].sort(
          (a, b) =>
            compareKeys(a.path, b.path) ||
            compareKeys(a.record_key, b.record_key) ||
            compareKeys(a.collected_at, b.collected_at),
        ),
      );
    }
  });

  it("returns stable sorted findings for identical snapshots regardless of row order", () => {
    const first = emptyInput();
    first.seo_issues.rows = [
      seoIssue(),
      seoIssue("https://shop.example.test/products/a", "title_missing", "标题为空。"),
    ];
    const second = emptyInput();
    second.seo_issues.rows = [...first.seo_issues.rows].reverse();

    expect(generateTodoRuleFindings(first)).toEqual(generateTodoRuleFindings(second));
  });

  it("does not claim complete absence when a source is partial or a positive hit lacks provenance", () => {
    const partial = emptyInput();
    partial.inventory_latest = snapshot([latest("DEMO-UNKNOWN", "unknown")], COLLECTED_AT, "partial");
    expect(generateTodoRuleFindings(partial).scan.status).toBe("partial");

    const untraceable = emptyInput();
    untraceable.seo_issues.rows = [seoIssue()];
    untraceable.seo_issues.collected_at = null;
    const result = generateTodoRuleFindings(untraceable);
    expect(result.scan.status).toBe("partial");
    expect(result.findings).toEqual([]);
  });

  it("returns not_run without an evaluation time when every source has not run", () => {
    const input = emptyInput();
    input.observed_at = null;
    input.seo_issues.status = "not_run";
    input.skus.status = "not_run";
    input.inventory_latest.status = "not_run";
    input.inventory_events.status = "not_run";
    input.site.status = "not_run";
    input.edm_candidates.status = "not_run";
    input.runs.status = "not_run";
    expect(generateTodoRuleFindings(input)).toEqual({ findings: [], scan: { status: "not_run", evaluated_at: null } });
  });

  it("rejects an invalid evaluation timestamp", () => {
    const input = emptyInput();
    input.observed_at = "not-a-date";
    expect(() => generateTodoRuleFindings(input)).toThrow("observed_at must be an ISO 8601 timestamp with timezone.");
  });

  it("marks invalid enabled grouping rules as failed without emitting a collision", () => {
    const input = emptyInput();
    input.skus.rows = [sku("DEMO-PARENT"), sku("DEMO-PARENT-child")];
    input.site.rows = [{ sku_grouping: { enabled: true, rule: { type: "regex", value: "[" } } }];
    const result = generateTodoRuleFindings(input);
    expect(result.scan.status).toBe("failed");
    expect(result.findings.some((finding) => finding.rule_id === "inventory.sku_grouping_collision")).toBe(false);
  });
});
