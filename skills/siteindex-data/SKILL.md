---
name: siteindex-data
version: 1.1.0
description: SiteIndex 项目数据目录、字段、查询命令与台账写入规则的基础参考。所有 SiteIndex 场景 skill 应先遵循本 skill。
reads:
  - README.md
  - AGENTS.md
  - index/context-brief.md
  - index/site.json
  - index/site/tech.json
  - index/
writes:
  - index/content/keywords.jsonl
  - index/ledgers/sku_media.csv
  - index/ledgers/sku_tags.csv
  - index/ledgers/edm_campaigns.jsonl
  - index/ledgers/outreach.jsonl
---

# SiteIndex 数据使用规范

## 5 分钟全局认知接入流（任何 Agent 必读）

1. **第一步**：阅读项目根目录 `README.md`（及 workspace 布局下的 `AGENTS.md`），了解项目概况、当前重点、工作规则与目录地图。
2. **第二步**：阅读 `<index>/context-brief.md`（legacy 为 `index/context-brief.md`，workspace 为 `_site-index/context-brief.md`）。该简报在 1 个文件中汇总了：
   - 品牌定位、受众、调性、核心 USP 与 SEO 核心关键词
   - 全站免邮门槛、配送/退换货/保修政策、官方客服与社媒主页、关键政策页 URL（标注 `[配置]` 或 `[提取自 URL]`）
   - 工作区 `01-brand` ~ `07-reports` 及 `_outputs` 下**已沉淀的文档、邮件模板、下载报表与待审产物只读清单**
   - 全站分类目录、价格带、导语摘要与代表商品 handle
   - 主推在售商品速查（含核心卖点 `highlights` 与规格参数 `specs`）、近期 EDM 活动冷却期及当前高优待办
3. **第三步**：根据具体任务按需读取下方对应数据表或调用 `siteindex query` / MCP 工具。只把台账写入 `<index>`；自动生成的数据由 SiteIndex 维护。

## 数据目录

- README.md / AGENTS.md：项目概况、Agent 工作规则、用户维护区块与 SiteIndex 自动区块。
- index/context-brief.md：面向 AI Agent 的 5 分钟全局认知简报（含工作区现有文件只读索引）。
- index/site.json：站点、品牌、政策覆盖（`policies`）、抓取、分类、SEO、EDM 与计划配置；没有表主键。
- index/.runner.json、index/.lock：执行设备和运行锁，由 SiteIndex 维护。
- index/site/：robots.txt、sitemaps.json、tech.json（全站免邮/退换/保修政策、关键页面 URL、联系方式与社媒链接）。
- index/catalog/：sku 主表、产品详情、分类。
- index/inventory/：当前库存、库存事件、每日分类汇总。
- index/seo/：页面、问题、内链。
- index/content/：博客索引和关键词映射台账。
- index/ledgers/：手动首图、产品标签、EDM campaign、外链去重台账。
- index/design/：tokens.json、brand.md、screenshots/。
- index/views/：按 SKU 或产品聚合的只读视图。
- index/reports/：daily 与 weekly 报告。
- index/archive/、index/logs/：归档、运行记录、校验报告和 Job 日志。
- index/ 以外的项目文件和目录由用户管理：只在 README「工作规则与偏好」约定或用户当次指定的位置创建或修改文件；不要主动扫描、移动、改名或删除其他文件。

## 表、主键与关键字段

路径均相对于项目根目录。★ 表示主键；复合主键按列出的字段组成。

| 路径 | 主键 | 关键字段 |
|---|---|---|
| index/catalog/skus.jsonl | sku | product_id、parent_sku、handle、title、variant_title、url、category、categories、category_source、product_type_raw、description、highlights、attributes（color/size/material/pattern/shipping_weight 等）、custom_labels、price、currency、image_url、status、first_seen、last_seen、updated_at |
| index/catalog/product_details.jsonl | handle | short_description（真实产品短描述 ≤300 字）、highlights（核心卖点 ≤8 条）、specs（结构化规格表 ≤20 项）、faqs（页面问答 ≤10 条）、warranty_note、rating、review_count、breadcrumbs、gallery、related_handles、badges、shipping_note、last_crawled |
| index/catalog/categories.json | slug | name、url、parent、source、title、meta_description、intro_excerpt（分类导语摘要 ≤240 字）、price_min、price_max、top_handles（代表商品 ≤5 个）、product_count、sku_count、in_stock_count、intro_text_words、last_seen |
| index/inventory/latest.jsonl | sku | stock_status、qty、since、checked_at |
| index/inventory/events/YYYY-MM.jsonl | date + sku + type | from、to、category、title；type 为 stock_change、price_change、new_sku、removed_sku、restored_sku 或 feed_anomaly |
| index/inventory/daily_summary.csv | date + category | total、in_stock、out_of_stock、preorder、unknown |
| index/seo/pages.jsonl | url | page_type、status_code、title、meta_description、canonical、indexable、in_sitemap、google_indexed、schema_types、links_internal_in、last_crawled |
| index/seo/issues.jsonl | url + rule | severity、detail、status、first_seen、last_seen |
| index/seo/links.jsonl | from + to + anchor | to_type、nofollow |
| index/content/blog_index.jsonl | url | slug、title、published_at、category、tags、meta_description、excerpt（正文首段摘要 ≤240 字）、word_count、outline、has_faq、faq_questions（FAQ 问题列表 ≤10 条）、primary_keyword、links_internal、links_products、links_in、linked_out_of_stock |
| index/content/keywords.jsonl | keyword（小写） | target_url、role、intent、cluster、status、priority、source、note、updated_at；搜索量、难度、排名字段为预留 |
| index/ledgers/sku_media.csv | sku + image_role | image_url、alt_text、source、width、height、updated_at、media_id、source_hash |
| index/ledgers/sku_tags.csv | sku | tags、priority、exclude_edm、email_blurb、season、note、updated_at、discount_tier |
| index/ledgers/edm_campaigns.jsonl | campaign_id | date、theme、status、subject、preheader、handles、promo_code、send_date、mailchimp_campaign_id |
| index/ledgers/outreach.jsonl | domain（小写） | added_at、status、linkflow_id、topic、note、target_url、live_link |
| index/views/products.jsonl | handle | product_id、title、url、category、price_min、price_max、currency、image_url、image_source、variant_count、skus、stock_status、tags、priority、exclude_edm、email_blurb、short_description、highlights、specs、attributes_summary、custom_labels、rating、review_count、first_seen、status |
| index/views/sku_stock.jsonl | sku | title、variant_title、category、price、stock_status、since、days_in_status、online_rate_7d、online_rate_30d、history_30d、last_change_at |
| index/logs/runs.jsonl | run_id | job、trigger、device_name、started_at、finished_at、status、counts、errors |
| index/logs/validation.json | 不适用（报告） | checked_at、trigger、summary、files[].path、kind、status、rule、message、line、repair |
| index/design/tokens.json、index/design/brand.md | 不适用 | colors、typography、spacing、radius、buttons、email_safe 及面向 Agent 的视觉与 EDM 邮件安全内联样式规范手册 |
| index/site/sitemaps.json、index/site/tech.json | 不适用 | sitemap 与全站技术/政策档案（`key_pages`、`policies` 免邮/退换/保修、`contact` 客服邮箱电话、`social_links`、`trust_badges`） |

## 查询与台账命令

query 只读已索引的数据。项目参数可传项目目录或项目名；字段筛选通过选项传入，翻页用 page 和 size。

~~~~bash
siteindex query <project> products --stock in --page 1 --size 50 --json
siteindex query <project> sku-stock --status out_of_stock --page 1 --size 50 --json
siteindex query <project> keywords --status planned --page 1 --size 50 --json
~~~~

台账优先通过 ledger 命令合并写入，不能用整文件覆盖来丢弃其他记录。rows 文件按台账格式提供 JSON/JSONL；sku_media 和 sku_tags 使用固定表头 CSV。标准输入可用短横线。

~~~~bash
siteindex ledger upsert <project> keywords --rows <file|-> --json
siteindex ledger upsert <project> sku_media --rows <file|-> --json
siteindex ledger upsert <project> sku_tags --rows <file|-> --json
siteindex ledger upsert <project> edm_campaigns --rows <file|-> --json
siteindex ledger upsert <project> outreach --rows <file|-> --json
siteindex ledger delete <project> <ledger> <primary-key> --json
~~~~

只向允许 agent/user 写入的台账提交变更：keywords、sku_media、sku_tags、edm_campaigns、outreach。写入前读取当前记录，按主键合并；先验证新增值来自用户、README 或可信的项目数据。命令不可用时，按下一节直接读写允许的台账文件。

## 直接读写格式与排序

- 文本使用 UTF-8 无 BOM、LF 换行；JSONL 每行一个紧凑 JSON 对象，无空格。
- JSONL 对象键顺序严格遵循对应 schema 的 properties 顺序；记录按主键逐字段字符串升序，使用普通字符串比较，不用 localeCompare。
- CSV 使用 DATA_SPEC 定义的固定列顺序；记录按主键升序；多值用分号分隔，空值写空单元格。
- JSON 使用 2 空格缩进并以换行结尾。日期为 YYYY-MM-DD；时间为带时区的 ISO 8601；空值为 null。
- 合并时保留其他行和未知但合法的字段；不要重排字段、改写无关值或修改自动生成数据。
- 直接落盘应先写同目录临时文件，再原子替换目标文件；不要留下半截文件。
- 默认只写上述台账路径。README 用户区块仅在用户明确要求时编辑；不要写 index 内自动生成的数据。

## 不得编造

不得编造 SKU、价格、库存状态或数量、图片 URL，也不得编造商品材质、尺寸、容量、核心卖点、免邮门槛、退换货或保修期限。
- 商品事实（卖点、规格参数、变体属性、短描述）优先直接从 `index/views/products.jsonl`（或 `index/catalog/product_details.jsonl`）的 `highlights`、`specs`、`attributes_summary`、`short_description`、`email_blurb` 读取。
- 全站政策（免邮门槛、配送、退换货、保修、客服邮箱电话、社媒链接、关键页面 URL）从 `index/site/tech.json` 或 `index/context-brief.md` 读取。
- 缺失、冲突或数据过期时应说明来源和日期并询问用户；没有来源的值保持空/null 或标注「待补充」，绝不能用相似产品补齐。
