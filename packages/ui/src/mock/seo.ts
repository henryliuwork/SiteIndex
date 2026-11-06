import { beginRun, delay, orphanSeoPages, projectConfigs, projectKey, reply, seoIssuesForProject, seoLinks, seoPages, selectRows, syncProjectSeoAttention } from "./context";
import type { ListQuery, SeoIssue, SeoPageFilters, SeoRule, SeoRuleSetting, SiteIndexApi } from "@siteindex/shared";
import { googleSiteSearchUrl, SEO_RULE_LABELS } from "@siteindex/shared";

const ruleSeverities: Record<SeoRule, SeoIssue["severity"]> = {
  http_4xx: "high", http_5xx: "high", redirect_chain: "mid", noindex: "low", canonical_other: "mid", canonical_missing: "low",
  not_in_sitemap: "low", title_missing: "mid", title_too_short: "low", title_too_long: "low", desc_missing: "mid",
  desc_too_short: "low", desc_too_long: "low", title_length: "low", desc_length: "low", title_duplicate: "mid",
  desc_duplicate: "mid", h1_missing: "low", h1_multiple: "low", schema_missing: "mid", schema_error: "mid",
  img_alt_missing: "low", hreflang_invalid: "mid", url_too_long: "low", thin_content: "low", orphan: "low",
};

const ruleDescriptions: Record<SeoRule, string> = {
  http_4xx: "页面请求返回 4xx 状态码。", http_5xx: "页面请求返回 5xx 状态码。", redirect_chain: "页面请求经过两次或更多次跳转。",
  noindex: "页面 robots meta 或 X-Robots-Tag 指示不收录。", canonical_other: "页面 canonical 地址指向另一个 URL。",
  canonical_missing: "页面没有 canonical 标签。", not_in_sitemap: "页面有站内链接，但未出现在 Sitemap 中。",
  title_missing: "页面缺少 Title。", title_too_short: "Title 短于 site.json 中设置的最小长度。",
  title_too_long: "Title 长于 site.json 中设置的最大长度。", desc_missing: "页面缺少 Meta description。",
  desc_too_short: "Meta description 短于 site.json 中设置的最小长度。", desc_too_long: "Meta description 长于 site.json 中设置的最大长度。",
  title_length: "兼容旧规则：Title 超出 site.json 配置的长度范围。", desc_length: "兼容旧规则：Meta description 超出 site.json 配置的长度范围。",
  title_duplicate: "多个页面使用了相同的 Title。", desc_duplicate: "多个页面使用了相同的 Meta description。",
  h1_missing: "页面缺少 H1 标题。", h1_multiple: "页面包含多个 H1 标题。", schema_missing: "产品页缺少 Product Schema，或博客页缺少 Article/BlogPosting Schema。",
  schema_error: "页面 Schema 缺少必填属性或结构无效。", img_alt_missing: "页面中有图片缺少 alt 文本。",
  hreflang_invalid: "页面 hreflang 标签存在无效语言代码或重复语言。", url_too_long: "页面 URL 超过建议长度。",
  thin_content: "博客正文少于 300 词，或分类页介绍少于 50 词。", orphan: "页面没有来自站内其他页面的入链。",
};

function normalizeIgnoreRules(rules: readonly { rule: SeoRule; url?: string }[]) {
  const unique = new Map<string, { rule: SeoRule; url?: string }>();
  for (const entry of rules) {
    const url = entry.url || undefined;
    unique.set(`${entry.rule}\n${url ?? ""}`, url ? { url, rule: entry.rule } : { rule: entry.rule });
  }
  return [...unique.values()].sort((left, right) => left.rule.localeCompare(right.rule) || (left.url ?? "").localeCompare(right.url ?? ""));
}

export function createSeoMock(): SiteIndexApi["seo"] {
  return {
    summary: (id) => reply(() => {
      const indexable = seoPages.filter((page) => page.indexable).length;
      const indexed = seoPages.filter((page) => page.google_indexed === true).length;
      const schemaPages = seoPages.filter((page) => page.status_code < 400 && page.schema_types.length > 0).length;
      const validPages = seoPages.filter((page) => page.status_code < 400).length;
      const issues = seoIssuesForProject(id);
      const openIssues = issues.filter((issue) => issue.status === "open");
      const severityCount = (severity: SeoIssue["severity"]) => openIssues.filter((issue) => issue.severity === severity).length;
      const issueCounts = new Map<string, { severity: SeoIssue["severity"]; count: number }>();
      for (const issue of issues) {
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
          { key: "issues", label: "开放问题", value: String(openIssues.length), hint: "高 " + severityCount("high") + " · 中 " + severityCount("mid") + " · 低 " + severityCount("low"), tone: openIssues.length ? "warn" : "ok" },
          { key: "schema", label: "Schema 覆盖", value: schemaPages + " / " + validPages },
          { key: "orphans", label: "孤立页面", value: String(orphanSeoPages.length), hint: "站内无人链接" },
        ],
        crawled_at: "2026-10-22T10:00:00+08:00", title_range: [30, 60] as [number, number], description_range: [120, 160] as [number, number],
        issue_counts: [...issueCounts].map(([rule, value]) => ({ rule, label: labels[rule] ?? rule, severity: value.severity, count: value.count })),
      };
    }),
    listIssues: (id, query) => reply(() => selectRows(
      seoIssuesForProject(id), query, (row) => [row.url, row.rule, row.detail, row.severity, row.status].join(" "),
      (row, filters) => (!filters.severity || row.severity === filters.severity) && (!filters.status || row.status === filters.status) && (!filters.rules?.length || filters.rules.includes(row.rule)),
      "severity", (row) => `${row.url}\u0000${row.rule}`,
    )),
    setIssueStatus: (id, input) => reply(() => {
      const config = projectConfigs[projectKey(id)];
      const issues = seoIssuesForProject(id);
      const targets = new Set(input.targets.map(({ url, rule }) => `${url}\u0000${rule}`));
      const currentRules = config.seo?.ignore_rules ?? [];
      const nextRules = normalizeIgnoreRules(input.status === "ignored"
        ? [...currentRules, ...input.targets.map(({ url, rule }) => ({ url, rule }))]
        : currentRules.filter((entry) => !entry.url || !targets.has(`${entry.url}\u0000${entry.rule}`)));
      projectConfigs[projectKey(id)] = { ...config, seo: { ...config.seo, ignore_rules: nextRules } };
      let updated = 0;
      for (const issue of issues) {
        if (!targets.has(`${issue.url}\u0000${issue.rule}`) || issue.status === input.status) continue;
        issue.status = input.status;
        updated += 1;
      }
      if (updated > 0) syncProjectSeoAttention(id);
      return { updated };
    }),
    setRuleIgnored: (id, rule, ignored) => reply(() => {
      const config = projectConfigs[projectKey(id)];
      const issues = seoIssuesForProject(id);
      const currentRules = config.seo?.ignore_rules ?? [];
      const nextRules = normalizeIgnoreRules(ignored
        ? [...currentRules.filter((entry) => entry.rule !== rule || entry.url), { rule }]
        : currentRules.filter((entry) => entry.rule !== rule || Boolean(entry.url)));
      projectConfigs[projectKey(id)] = { ...config, seo: { ...config.seo, ignore_rules: nextRules } };
      let updated = 0;
      for (const issue of issues) {
        if (issue.rule !== rule) continue;
        const nextStatus = ignored && issue.status === "open" ? "ignored"
          : !ignored && issue.status === "ignored" && !nextRules.some((entry) => entry.rule === rule && entry.url === issue.url) ? "open"
            : issue.status;
        if (issue.status !== nextStatus) { issue.status = nextStatus; updated += 1; }
      }
      if (updated > 0) syncProjectSeoAttention(id);
      return { updated };
    }),
    getRuleSettings: (id) => reply(() => {
      const issues = seoIssuesForProject(id);
      const ignoreRules = projectConfigs[projectKey(id)].seo?.ignore_rules ?? [];
      return (Object.keys(SEO_RULE_LABELS) as SeoRule[]).sort().map((rule): SeoRuleSetting => {
        const configured = ignoreRules.filter((entry) => entry.rule === rule);
        return {
          rule,
          name: SEO_RULE_LABELS[rule],
          description: ruleDescriptions[rule],
          severity: ruleSeverities[rule],
          pending_count: issues.filter((issue) => issue.rule === rule && issue.status === "open").length,
          ignored: configured.some((entry) => !entry.url),
          ignored_urls: [...new Set(configured.flatMap((entry) => entry.url ? [entry.url] : []))].sort(),
        };
      });
    }),
    listPages: (_id, query: ListQuery<SeoPageFilters>) => reply(() => selectRows(
      seoPages, query, (row) => [row.url, row.title, row.meta_description, row.page_type].join(" "),
      (row, filters) => (!filters.page_type || row.page_type === filters.page_type) && (!filters.indexed || (filters.indexed === "yes" ? row.google_indexed === true : filters.indexed === "no" ? row.google_indexed === false : row.google_indexed == null)),
      "url", (row) => row.url,
    )),
    listLinks: (_id, query) => reply(() => selectRows(
      seoLinks, query, (row) => [row.from, row.to, row.anchor, row.to_type].join(" "), () => true,
      "from", (row) => `${row.from}\u0000${row.to}\u0000${row.anchor}`,
    )),
    orphanPages: () => reply([...orphanSeoPages]),
    getPage: (_id, url) => reply(seoPages.find((page) => page.url === url) ?? null),
    googleSiteUrl: (url) => reply(googleSiteSearchUrl(url)),
    checkIndex: async (id, _urls) => { await delay(); return { runId: beginRun("C:/SiteIndex/Projects/" + id, "index-check") }; },
  };
}
