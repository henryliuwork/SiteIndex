import { beginRun, delay, orphanSeoPages, reply, seoIssues, seoLinks, seoPages, selectRows } from "./context";
import type { ListQuery, SeoIssue, SeoPageFilters, SiteIndexApi } from "@siteindex/shared";
import { googleSiteSearchUrl } from "@siteindex/shared";

export function createSeoMock(): SiteIndexApi["seo"] {
  return {
    summary: () => reply(() => {
      const indexable = seoPages.filter((page) => page.indexable).length;
      const indexed = seoPages.filter((page) => page.google_indexed === true).length;
      const schemaPages = seoPages.filter((page) => page.status_code < 400 && page.schema_types.length > 0).length;
      const validPages = seoPages.filter((page) => page.status_code < 400).length;
      const severityCount = (severity: SeoIssue["severity"]) => seoIssues.filter((issue) => issue.severity === severity).length;
      const issueCounts = new Map<string, { severity: SeoIssue["severity"]; count: number }>();
      for (const issue of seoIssues) {
        const current = issueCounts.get(issue.rule);
        issueCounts.set(issue.rule, { severity: current?.severity ?? issue.severity, count: (current?.count ?? 0) + 1 });
      }
      const labels: Record<string, string> = {
        http_4xx: "页面 4xx", http_5xx: "页面 5xx", redirect_chain: "重定向链", noindex: "noindex",
        canonical_other: "Canonical 指向其他页面", canonical_missing: "Canonical 缺失", not_in_sitemap: "未在 Sitemap 中",
        title_missing: "Title 缺失", desc_missing: "Meta description 缺失", title_length: "Title 长度异常",
        desc_length: "Description 长度异常", title_duplicate: "Title 重复", desc_duplicate: "Description 重复",
        h1_missing: "H1 缺失", h1_multiple: "H1 多个", schema_missing: "Schema 缺失", schema_error: "Schema 错误",
        img_alt_missing: "图片 Alt 缺失", thin_content: "内容过短", orphan: "孤立页面",
      };
      return {
        kpis: [
          { key: "pages", label: "已抓取页面", value: String(seoPages.length) },
          { key: "indexable", label: "可索引", value: String(indexable), hint: "无 noindex 且 canonical 指向自身" },
          { key: "indexed", label: "收录", value: indexed + " / " + seoPages.length, hint: "Google site: 检查 · 10-19" },
          { key: "issues", label: "问题", value: String(seoIssues.length), hint: "高 " + severityCount("high") + " · 中 " + severityCount("mid") + " · 低 " + severityCount("low"), tone: "warn" },
          { key: "schema", label: "Schema 覆盖", value: schemaPages + " / " + validPages },
          { key: "orphans", label: "孤立页面", value: String(orphanSeoPages.length), hint: "站内无人链接" },
        ],
        crawled_at: "2026-10-22T10:00:00+08:00", title_range: [30, 60] as [number, number], description_range: [120, 160] as [number, number],
        issue_counts: [...issueCounts].map(([rule, value]) => ({ rule, label: labels[rule] ?? rule, severity: value.severity, count: value.count })),
      };
    }),
    listIssues: (_id, query) => reply(() => selectRows(seoIssues, query, (row) => [row.url, row.rule, row.detail].join(" "), (row, filters) => (!filters.severity || row.severity === filters.severity) && (!filters.status || row.status === filters.status) && (!filters.rules?.length || filters.rules.includes(row.rule)))),
    listPages: (_id, query: ListQuery<SeoPageFilters>) => reply(() => selectRows(seoPages, query, (row) => [row.url, row.title, row.meta_description].join(" "), (row, filters) => (!filters.page_type || row.page_type === filters.page_type) && (!filters.indexed || (filters.indexed === "yes" ? row.google_indexed === true : filters.indexed === "no" ? row.google_indexed === false : row.google_indexed == null)))),
    listLinks: (_id, query) => reply(() => selectRows(seoLinks, query, (row) => [row.from, row.to, row.anchor, row.to_type].join(" "))),
    orphanPages: () => reply([...orphanSeoPages]),
    getPage: (_id, url) => reply(seoPages.find((page) => page.url === url) ?? null),
    googleSiteUrl: (url) => reply(googleSiteSearchUrl(url)),
    checkIndex: async (id, _urls) => { await delay(); return { runId: beginRun("C:/SiteIndex/Projects/" + id, "index-check") }; },
  };
}
