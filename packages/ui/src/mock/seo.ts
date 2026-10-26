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
      };
    }),
    listIssues: (_id, query) => reply(() => selectRows(seoIssues, query, (row) => [row.url, row.rule, row.detail].join(" "), (row, filters) => (!filters.severity || row.severity === filters.severity) && (!filters.status || row.status === filters.status))),
    listPages: (_id, query: ListQuery<SeoPageFilters>) => reply(() => selectRows(seoPages, query, (row) => [row.url, row.title, row.meta_description].join(" "), (row, filters) => (!filters.page_type || row.page_type === filters.page_type) && (!filters.indexed || (filters.indexed === "yes" ? row.google_indexed === true : filters.indexed === "no" ? row.google_indexed === false : row.google_indexed == null)))),
    listLinks: (_id, query) => reply(() => selectRows(seoLinks, query, (row) => [row.from, row.to, row.anchor, row.to_type].join(" "))),
    orphanPages: () => reply([...orphanSeoPages]),
    getPage: (_id, url) => reply(seoPages.find((page) => page.url === url) ?? null),
    googleSiteUrl: (url) => reply(googleSiteSearchUrl(url)),
    checkIndex: async (id, _urls) => { await delay(); return { runId: beginRun("C:/SiteIndex/Projects/" + id, "index-check") }; },
  };
}
