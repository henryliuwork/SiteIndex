import type { SiteIndexApi } from "@siteindex/shared";
import { generatedBlogs, generatedKeywords, reply, selectRows, seoPages } from "./context";

function hasArticleSchema(url: string): boolean {
  const page = seoPages.find((candidate) => candidate.url === url);
  return Boolean(page?.schema_types?.some((type) => /article|blogposting/i.test(type)));
}

export function createContentMock(): SiteIndexApi["content"] {
  return {
    summary: () => reply({
      kpis: [
        { key: "blogs", label: "博客文章", value: "44" },
        { key: "no_schema", label: "缺少 schema", value: String(generatedBlogs.filter((row) => !hasArticleSchema(row.url)).length) },
        { key: "no_links", label: "正文无站内链接", value: String(generatedBlogs.filter((row) => row.links_internal.length === 0 && row.links_products.length === 0).length) },
        { key: "links_oos", label: "链接到缺货产品", value: String(generatedBlogs.filter((row) => (row.linked_out_of_stock?.length ?? 0) > 0).length), tone: "warn" },
        { key: "keywords", label: "关键词", value: String(generatedKeywords.length), hint: "已上线 39 · 计划 11" },
        { key: "uncovered", label: "核心词未覆盖", value: "2", hint: "product guide · home essentials", tone: "warn" },
      ], uncovered_core_keywords: ["product guide", "home essentials"],
    }),
    listBlog: (_id, query) => reply(() => selectRows(
      generatedBlogs, query, (row) => [row.url, row.title, row.slug, row.author, row.category, row.tags].join(" "),
      (row, filters) => !filters.issue || (filters.issue === "no_links" ? row.links_internal.length === 0 && row.links_products.length === 0 : filters.issue === "no_schema" ? !hasArticleSchema(row.url) : (row.linked_out_of_stock?.length ?? 0) > 0),
      "published_at", (row) => row.url,
    )),
    listKeywords: (_id, query) => reply(() => selectRows(
      generatedKeywords, query, (row) => [row.keyword, row.target_url, row.cluster, row.intent, row.note].join(" "),
      (row, filters) => (!filters.role || row.role === filters.role) && (!filters.status || row.status === filters.status),
      "keyword", (row) => row.keyword,
    )),
    listDrafts: () => reply([]),
  };
}
