---
name: siteindex-data
version: 1.1.0
description: SiteIndex 项目数据目录、字段、查询命令与台账写入规则的基础参考。所有 SiteIndex 场景 skill 应先遵循本 skill。
reads:
  - README.md
  - index/site.json
  - index/
writes:
  - index/content/keywords.jsonl
  - index/ledgers/sku_media.csv
  - index/ledgers/sku_tags.csv
  - index/ledgers/edm_campaigns.jsonl
  - index/ledgers/outreach.jsonl
---

# SiteIndex 数据使用规范

先阅读项目 README 的「项目概况」「当前重点」「工作规则与偏好」，再按任务读取 index 数据。数据格式以 DATA_SPEC.md 为准。只把台账写入 index；自动生成的数据由 SiteIndex 维护。

## 数据目录

- README.md：项目概况、用户维护区块与 SiteIndex 自动区块。
- index/site.json：站点、品牌、抓取、分类、SEO、EDM 与计划配置；没有表主键。
- index/.runner.json、index/.lock：执行设备和运行锁，由 SiteIndex 维护。
- index/site/：robots.txt、sitemaps.json、tech.json。
- index/catalog/：sku 主表、产品详情、分类。
- index/inventory/：当前库存、库存事件、每日分类汇总。
- index/seo/：页面、问题、内链。
- index/content/：博客索引和关键词映射台账。
- index/ledgers/：手动首图、产品标签、EDM campaign、外链去重台账。
- index/design/：tokens.json、brand.md、screenshots/。
- index/views/：按 SKU 或产品聚合的只读视图。
- index/reports/：daily 与 weekly 报告。
- index/archive/、index/logs/：归档、运行记录、校验报告和 Job 日志。
- index/ 以外的项目文件和目录由用户管理；不要扫描、创建、移动、改名或删除它们。

## 表、主键与关键字段

路径均相对于项目根目录。★ 表示主键；复合主键按列出的字段组成。

| 路径 | 主键 | 关键字段 |
|---|---|---|
| index/catalog/skus.jsonl | sku | product_id、handle、title、variant_title、url、category、categories、category_source、price、currency、image_url、status、first_seen、last_seen、updated_at |
| index/catalog/product_details.jsonl | handle | short_description、rating、review_count、breadcrumbs、gallery、related_handles、badges、shipping_note、last_crawled |
| index/catalog/categories.json | slug | name、url、parent、source、product_count、sku_count、in_stock_count、intro_text_words、last_seen |
| index/inventory/latest.jsonl | sku | stock_status、qty、since、checked_at |
| index/inventory/events/YYYY-MM.jsonl | date + sku + type | from、to、category、title；type 为 stock_change、price_change、new_sku、removed_sku 或 restored_sku |
| index/inventory/daily_summary.csv | date + category | total、in_stock、out_of_stock、preorder、unknown |
| index/seo/pages.jsonl | url | page_type、status_code、title、meta_description、canonical、indexable、in_sitemap、google_indexed、schema_types、links_internal_in、last_crawled |
| index/seo/issues.jsonl | url + rule | severity、detail、status、first_seen、last_seen |
| index/seo/links.jsonl | from + to + anchor | to_type、nofollow |
| index/content/blog_index.jsonl | url | slug、title、published_at、category、tags、meta_description、word_count、outline、primary_keyword、links_internal、links_products、links_in、linked_out_of_stock |
| index/content/keywords.jsonl | keyword（小写） | target_url、role、intent、cluster、status、priority、source、note、updated_at；搜索量、难度、排名字段为预留 |
| index/ledgers/sku_media.csv | sku + image_role | image_url、alt_text、source、width、height、updated_at |
| index/ledgers/sku_tags.csv | sku | tags、priority、exclude_edm、email_blurb、season、note、updated_at |
| index/ledgers/edm_campaigns.jsonl | campaign_id | date、theme、status、subject、preheader、handles、promo_code、send_date、mailchimp_campaign_id |
| index/ledgers/outreach.jsonl | domain（小写） | added_at、status、linkflow_id、topic、note、target_url、live_link |
| index/views/products.jsonl | handle | product_id、title、url、category、price_min、price_max、currency、image_url、image_source、variant_count、skus、stock_status、tags、priority、exclude_edm、first_seen、status |
| index/views/sku_stock.jsonl | sku | title、variant_title、category、price、stock_status、since、days_in_status、online_rate_7d、online_rate_30d、history_30d、last_change_at |
| index/logs/runs.jsonl | run_id | job、trigger、device_name、started_at、finished_at、status、counts、errors |
| index/logs/validation.json | 不适用（报告） | checked_at、trigger、summary、files[].path、kind、status、rule、message、line、repair |
| index/design/tokens.json | 不适用 | colors、typography、spacing、radius、components、extracted_at、email_safe |
| index/site/sitemaps.json、index/site/tech.json | 不适用 | sitemap 与站点技术信息；具体字段以 schema 为准 |

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

不得编造 SKU、价格、库存状态或数量、图片 URL。也不得推测可用库存、变体关系、折扣、联系方式或收录状态。SKU/价格/库存/产品图片只能来自 index 数据或用户提供的原始资料；缺失、冲突或数据过期时应说明来源和日期并询问用户。没有来源的值保持空/null，绝不能用相似产品补齐。
