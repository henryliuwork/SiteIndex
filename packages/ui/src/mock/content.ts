import type { SiteIndexApi } from "@siteindex/shared";
import { generatedBlogs, generatedDrafts, generatedKeywords, reply, selectRows } from "./context";

export function createContentMock(): SiteIndexApi["content"] {
  return {
    summary: () => reply({
      kpis: [
        { key: "blogs", label: "博客文章", value: "44" },
        { key: "no_schema", label: "缺少 schema", value: String(generatedBlogs.filter((row) => !row.has_faq).length) },
        { key: "no_links", label: "正文无站内链接", value: String(generatedBlogs.filter((row) => row.links_internal.length === 0 && row.links_products.length === 0).length) },
        { key: "links_oos", label: "链接到缺货产品", value: String(generatedBlogs.filter((row) => (row.linked_out_of_stock?.length ?? 0) > 0).length), tone: "warn" },
        { key: "keywords", label: "关键词", value: String(generatedKeywords.length), hint: "已上线 39 · 计划 11" },
        { key: "uncovered", label: "核心词未覆盖", value: "2", hint: "suit feeders · bird baths", tone: "warn" },
      ], uncovered_core_keywords: ["suit feeders", "bird baths"],
    }),
    listBlog: (_id, query) => reply(() => selectRows(generatedBlogs, query, (row) => [row.title, row.slug, row.category, row.primary_keyword].join(" "), (row, filters) => !filters.issue || (filters.issue === "no_links" ? row.links_internal.length === 0 && row.links_products.length === 0 : filters.issue === "no_schema" ? !row.has_faq : (row.linked_out_of_stock?.length ?? 0) > 0))),
    listKeywords: (_id, query) => reply(() => selectRows(generatedKeywords, query, (row) => [row.keyword, row.cluster, row.target_url].join(" "), (row, filters) => (!filters.role || row.role === filters.role) && (!filters.status || row.status === filters.status))),
    listDrafts: () => reply(generatedDrafts),
  };
}
