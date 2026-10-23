---
name: blog-writer
version: 1.0.0
description: 基于当前网站项目的品牌、关键词映射、博客索引与在售产品，规划并撰写 SEO 博客（brief、带内链正文、meta），并登记关键词防止蚕食。用户要求写博客、规划选题、加内链时使用；可配合平台上的 SEO 写作 skill。
reads:
  - README.md
  - index/site.json
  - index/content/keywords.jsonl
  - index/content/blog_index.jsonl
  - index/catalog/categories.json
  - index/views/products.jsonl
writes:
  - 内容/drafts/
  - index/content/keywords.jsonl
---

# blog-writer

工作目录为项目根目录。读取：README.md（调性与规则）、`index/site.json`（brand、seo.core_keywords、locale）、`index/content/keywords.jsonl`、`index/content/blog_index.jsonl`、`index/catalog/pages.jsonl`（type=collection）、`index/views/products.jsonl`。草稿目录以 README「任务路由」为准（默认 `内容/drafts/`）。

## 1. 选题与蚕食检查

- 主关键词已在 keywords.jsonl 且 `target_url` 非空 → 停止，建议更新该页面或换角度
- blog_index 中标题/slug 相近的文章 → 列出请用户确认
- 用户要求选题时：从 core_keywords、分类页、在售主力产品出发，排除已占用关键词，给 5 个候选（关键词 · 意图 · 目标分类 · 理由）

登记：

```bash
echo '{"keyword":"…","target_url":null,"role":"primary","intent":"informational","cluster":"…","status":"drafting","source":"blog-writer"}' | siteindex ledger upsert . keywords --rows -
```

## 2. Brief（`{drafts}/{YYYY-MM-DD}-{slug}/brief.md`）

关键词、意图、读者、文章类型、H2/H3 大纲；**内链计划**（URL 必须来自数据文件）：相关博客 3–5、分类页 1–2、有货产品 2–4，写明锚文本与位置；反向内链建议 2–3 篇。

## 3. 正文与 meta

`draft.md`：语言同 `locale`；主关键词出现在标题、首段、至少一个 H2、结尾；不编造数据与评测结论；不写价格或注明以页面为准。
`meta.json`：`{"title":"≤60字符","meta_description":"≤155字符","slug":"…","target_keyword":"…","status":"draft"}`

## 4. 发布后

用户提供 URL → 关键词 `target_url` 设为该 URL、`status=live`。blog_index 由每周同步自动更新。

## 交付

标题、meta、字数、内链清单（锚文本 → URL）、反向内链建议。

## CLI 不可用时

直接读取本文件列出的 README 与 index 数据。登记关键词时，按 DATA_SPEC §5.11 以 keyword 为键合并 `index/content/keywords.jsonl`，不要重复已有主键；按 keyword 升序写 UTF-8 无 BOM、LF 的 JSONL，保留 schema 字段顺序，并为新行填写 `updated_at`。草稿仍写入 README「任务路由」指定的工作区目录，不写入 index。
