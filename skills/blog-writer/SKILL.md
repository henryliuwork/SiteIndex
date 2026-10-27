---
name: blog-writer
version: 1.1.0
description: 基于项目品牌、关键词映射、博客索引与产品数据规划或撰写 SEO 博客，并在需要时登记关键词映射。
reads:
  - README.md
  - index/site.json
  - index/content/keywords.jsonl
  - index/content/blog_index.jsonl
  - index/seo/pages.jsonl
  - index/views/products.jsonl
writes:
  - index/content/keywords.jsonl
---

# blog-writer

先遵循 siteindex-data 的数据格式与不编造规则。

## 读哪些数据

读取 README 的品牌语气与工作规则；index/site.json 的 brand、locale、seo.core_keywords；index/content/keywords.jsonl、index/content/blog_index.jsonl、index/seo/pages.jsonl、index/views/products.jsonl。只在选题涉及分类或产品时读取 index/catalog/categories.json 或相应产品数据。

## 如何筛选判断

- 检查主关键词是否已映射 target_url；已映射时指出现有目标，先询问用户是否要更新该页面或换角度，避免关键词蚕食。
- 对照博客标题、slug、primary_keyword 与 SEO 页面，排除重复主题。用明确的匹配数据说明候选理由。
- 用户要求选题时，提供 5 个候选及关键词、搜索意图、相关页面和理由；不编造搜索量、难度、排名或市场数据。
- 草稿按 locale 写作；主关键词自然出现在标题、首段和至少一个小标题。只有数据或用户资料能支持的链接、产品、品牌信息才可写入；不捏造价格、库存、产品效果或评测。
- 文章内容与 brief 交付给用户；保存位置由 README 工作规则或用户当次指定。没有用户指定时不要创建固定草稿目录。

## 写哪些台账

仅在用户确认登记关键词映射时，按 keyword（小写）合并更新 index/content/keywords.jsonl。target_url 只使用用户给出的真实 URL；新选题未发布时可按 schema 使用 null。role、intent、cluster、status 必须反映用户确认的计划。按 DATA_SPEC §5.11 保留 schema 字段顺序、keyword 升序及 UTF-8 无 BOM、LF，并填写真实 updated_at；没有确认的主题不要先占用台账。
