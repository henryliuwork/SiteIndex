# SiteIndex · 数据规范（schema_version 1.1）

> 本文是数据格式的唯一依据。机器可读定义在 `schemas/`，TypeScript 类型在 `packages/shared/src/models.ts`，路径常量在 `packages/shared/src/paths.ts`——三者必须与本文一致，改动时同一个 PR 一起改。
> `reference/` 中的 Python 参考实现使用 1.0 的旧目录，路径对照见第 9 节。

## 1. 项目文件夹

> 2026-10-27 起：软件不再管理工作区文件夹，聚焦网站数据索引，见 `docs/decisions/2026-10-27-data-index-focus.md`。

```
{projects_root}/kingsyard/
├── README.md                     项目说明（用户区块 + 自动区块）
├── AGENTS.md                     "先阅读 README.md"
├── CLAUDE.md                     "@README.md"
├── _agent/skills/{name}/SKILL.md 软件分发的 skill + _agent/skills/manifest.json
├── index/                        ← 网站数据（软件维护，台账除外）
│   ├── site.json                 站点配置
│   ├── .runner.json              执行设备
│   ├── .lock                     运行锁（仅运行中存在）
│   ├── site/        robots.txt · sitemaps.json · tech.json
│   ├── catalog/     skus.jsonl · product_details.jsonl · categories.json
│   ├── inventory/   latest.jsonl · events/YYYY-MM.jsonl · daily_summary.csv
│   ├── seo/         pages.jsonl · issues.jsonl · links.jsonl
│   ├── content/     blog_index.jsonl · keywords.jsonl(台账)
│   ├── ledgers/     sku_media.csv · sku_tags.csv · edm_campaigns.jsonl · outreach.jsonl
│   ├── design/      tokens.json · brand.md · screenshots/
│   ├── views/       products.jsonl · sku_stock.jsonl
│   ├── reports/     daily/YYYY-MM-DD.md · weekly/YYYY-Www.md
│   ├── archive/     YYYY-MM/*.gz
│   └── logs/        runs.jsonl · validation.json · jobs/{runId}.log
└── …                              ← 用户自己的工作目录（软件不创建、不读写）
```
本机缓存（不进云盘）：`{cache_dir}/{projectId}/index.db`、`{cache_dir}/{projectId}/ui-state.json`

## 2. 写入权限

| 路径 | 写入方 |
|---|---|
| `index/`（下列台账除外） | 仅 SiteIndex（执行设备的定时任务，或用户手动触发） |
| `index/site.json` | SiteIndex 设置界面 / 用户手改 |
| `index/content/keywords.jsonl`、`index/ledgers/*` | agent 与用户，经 `siteindex ledger` 或软件界面；手写须严格遵守格式与排序 |
| `README.md` 用户区块 | 用户、agent、软件（README 页） |
| `README.md` 自动区块、`_agent/`、`AGENTS.md`、`CLAUDE.md` | 仅 SiteIndex |
| `index/`、`_agent/` 以外的其他目录与文件 | 用户与 agent 自由使用，软件不读写、不校验 |

## 3. 通用格式

- UTF-8 无 BOM，LF 换行
- **JSONL**：一行一个对象；按主键升序（逐字段字符串比较，不用 localeCompare）；键顺序 = schema `properties` 顺序；`JSON.stringify` 无空格
- **CSV**：首行表头（固定顺序）；按主键升序；多值 `;` 分隔；空值为空单元格
- **JSON**：2 空格缩进，末尾换行
- 日期 `YYYY-MM-DD`；时间 ISO 8601 带时区（项目 `timezone`）
- 金额为 number；货币单独字段
- URL 为绝对地址，去掉 utm_*、gclid、gbraid、wbraid、srsltid、fbclid、mc_*、_ga 与空值参数
- 空值为 `null`
- 所有写入为原子写（临时文件 → fsync → rename，Windows 占用重试）

## 4. 配置文件

### 4.1 `index/site.json`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `schema_version` | string | ✓ | `"1.1"` |
| `domain` / `base_url` | string | ✓ | `kingsyard.com` / `https://www.kingsyard.com` |
| `platform` | enum | ✓ | `magento` `wordpress` `woocommerce` `shopify` `other` |
| `currency` `locale` `timezone` | string | ✓ | |
| `markets` | string[] | | |
| `brand` | object | ✓ | `name`✓ `tagline` `voice` `audience` `usp[]` |
| `sitemaps` | string[] | ✓ | |
| `crawl.adapter` | string | ✓ | `gmc_feed` |
| `crawl.feed_url` | string \| string[] | ✓ | |
| `crawl.sku_field` | string | | 默认 `id` |
| `crawl.category_depth` | int | | 默认 1；feed 分类层级 |
| `crawl.missing_as` | enum | | `out_of_stock`（默认）/ `removed` |
| `crawl.missing_removed_after_days` | int | | 默认 30 |
| `crawl.max_removed_ratio` | number | | 默认 0.10 |
| `crawl.feed_generated_at` | string | | 说明性，如 `"01:00"` |
| `crawl.blog_url_patterns` / `exclude_url_patterns` | string[] | | 正则 |
| `crawl.max_pages` | int | | 默认 2000 |
| `crawl.crawl_product_pages` | bool | | 默认 true |
| `crawl.rate_limit_ms` | int | ✓ | 默认 1500，最小 200 |
| `crawl.user_agent` | string | | |
| `crawl.overrides` | object | | `{sku: {字段: 值}}` |
| `categories.mode` | enum | ✓ | `url_rule` / `feed` / `manual` |
| `categories.url_pattern` | string | | url_rule 模式，如 `/collections/{slug}`，多个用 `,` 分隔 |
| `categories.manual` | array | | `[{slug, name, url, match: [{type, value}]}]`，type ∈ `product_type_contains` `sku_prefix` `url_contains` `skus` |
| `seo.core_keywords` / `seo.competitors` | string[] | | |
| `seo.title_range` / `seo.description_range` | [int,int] | | 默认 `[30,60]` / `[120,160]` |
| `seo.ignore_rules` | `[{url, rule}]` | | |
| `edm.platform` | string | | `mailchimp` / `wordpress` / `other` |
| `edm.max_products` / `edm.cooldown_days` | int | | 6 / 21 |
| `edm.utm` | object | | `{source, medium}` |
| `edm.image_priority` | string[] | | 默认 `["feed", "manual"]` |
| ~~`workspace_folders`~~ | — | | 已废弃：读取时忽略，写回时去掉 |
| `schedule` | object | ✓ | 见 4.2 |
| `integrations.linkflow` | object | | `{mcp_server, create_tool, project}` |
| `integrations.sales` / `gsc` / `mailchimp` | object | | 预留，MVP 不使用 |
| `readme.disabled_blocks` | string[] | | 用户删掉的自动区块 |

### 4.2 `schedule`
```json
{
  "daily":    {"enabled": true,  "days": [1,2,3,4,5,6,7], "time": "02:00"},
  "validate": {"enabled": true,  "days": [1,2,3,4,5,6,7], "time": "02:30"},
  "weekly":   {"enabled": true,  "days": [1], "time": "03:00"},
  "readme":   {"enabled": true,  "days": [7], "time": "05:00"},
  "monthly":  {"enabled": true,  "day_of_month": 1, "time": "04:00"},
  "options":  {"wake_to_run": true, "run_if_missed": true, "notify_on_failure": true, "validate_after_sync": true}
}
```
`days`：1 = 周一 … 7 = 周日。

### 4.3 `index/.runner.json` / `index/.lock`
```json
{"device_id": "uuid", "device_name": "Henry-PC", "claimed_at": "…"}
{"device_id": "uuid", "device_name": "Henry-PC", "pid": 1234, "job": "daily", "started_at": "…", "heartbeat": "…"}
```

## 5. 数据表

主键 ★；必填 ✓。

### 5.1 `catalog/skus.jsonl`（★sku · 每日 · feed）
`sku`★ `product_id`✓ `handle`✓ `title`✓ `variant_title` `url`✓ `category`✓ `categories` `category_source`✓(`url_rule`/`feed`/`manual`/`none`) `price`✓ `compare_at_price` `currency`✓ `image_url` `additional_images` `gtin` `mpn` `brand` `status`✓(`active`/`removed`) `first_seen`✓ `last_seen`✓ `updated_at`✓

- `category`：按 `categories.mode` 计算；manual 模式按规则顺序匹配第一个命中；未命中为 `uncategorized`
- `image_url`：feed `image_link`（**抓取首图**）

### 5.2 `catalog/product_details.jsonl`（★handle · 每周 · 产品页）
`handle`★ `short_description` `rating` `review_count` `breadcrumbs` `gallery` `related_handles` `badges` `shipping_note` `last_crawled`✓

### 5.3 `catalog/categories.json`（★slug · 每周）
数组：`slug`★ `name`✓ `url`✓(未匹配为 `""`) `parent` `source`✓ `product_count` `sku_count` `in_stock_count` `intro_text_words` `last_seen`✓

### 5.4 `inventory/latest.jsonl`（★sku · 每日）
`sku`★ `stock_status`✓(`in_stock`/`out_of_stock`/`preorder`/`unknown`) `qty` `since`✓ `checked_at`✓

### 5.5 `inventory/events/YYYY-MM.jsonl`（★date+sku+type · 每日追加）
`date`★ `sku`★ `type`★(`stock_change`/`price_change`/`new_sku`/`removed_sku`/`restored_sku`) `from` `to` `category`✓ `title`✓

### 5.6 `inventory/daily_summary.csv`（★date+category）
`date,category,total,in_stock,out_of_stock,preorder,unknown`；每天每分类一行 + `_all`；只计 active

### 5.7 `seo/pages.jsonl`（★url · 每周 · sitemap 全部页面，含产品页与博客）
`url`★ `page_type`✓(`home`/`collection`/`product`/`blog`/`page`/`other`) `status_code`✓ `final_url` `redirect_chain` `response_ms` `title` `title_length` `meta_description` `description_length` `meta_keywords` `h1` `h1_count` `h2` `canonical` `canonical_status`(`self`/`other`/`missing`) `robots_meta` `x_robots_tag` `indexable`✓ `in_sitemap`✓ `google_indexed`(bool?) `index_checked_at` `hreflang` `og` `twitter_card` `schema_types` `schema_errors` `word_count` `images_total` `images_missing_alt` `links_internal_out` `links_external_out` `links_internal_in` `last_crawled`✓

### 5.8 `seo/issues.jsonl`（★url+rule · 每周）
`url`★ `rule`★ `severity`✓(`high`/`mid`/`low`) `detail`✓ `status`✓(`open`/`fixed`/`ignored`) `first_seen`✓ `last_seen`✓

规则与默认级别：

| rule | 级别 | 条件 |
|---|---|---|
| `http_4xx` / `http_5xx` | high | 状态码 |
| `redirect_chain` | mid | 跳转 ≥ 2 次 |
| `noindex` | low | robots_meta 或 X-Robots-Tag 含 noindex |
| `canonical_other` | mid | canonical 指向其他 URL |
| `canonical_missing` | low | |
| `not_in_sitemap` | low | 页面被站内链接但不在 sitemap |
| `title_missing` / `desc_missing` | mid | |
| `title_length` / `desc_length` | low | 超出 site.json 范围 |
| `title_duplicate` / `desc_duplicate` | mid | 多个页面相同 |
| `h1_missing` / `h1_multiple` | low | |
| `schema_missing` | mid | 产品页无 Product；博客无 Article/BlogPosting |
| `schema_error` | mid | 必填属性缺失 |
| `img_alt_missing` | low | |
| `thin_content` | low | 博客 < 300 词、分类页介绍 < 50 词 |
| `orphan` | low | 站内无入链 |

`seo.ignore_rules` 命中的标为 `ignored`；上次存在本次不存在的标为 `fixed`（保留 30 天后删除）。

### 5.9 `seo/links.jsonl`（★from+to+anchor · 每周）
`from`★ `to`★ `anchor`★ `to_type`✓(`product`/`collection`/`blog`/`page`) `nofollow`；只记正文区域（排除 header/nav/footer/aside）

### 5.10 `content/blog_index.jsonl`（★url · 每周）
`url`★ `slug`✓ `title`✓ `published_at`✓ `updated_at` `category` `author` `tags` `meta_description` `word_count` `reading_minutes` `outline` `has_faq` `featured_image` `primary_keyword` `links_internal` `links_products` `links_in` `linked_out_of_stock` `last_crawled`✓

### 5.11 `content/keywords.jsonl`（★keyword · 台账）
`keyword`★(小写) `target_url`✓(可 null) `role`✓(`primary`/`secondary`) `intent`✓ `cluster`✓ `status`✓(`planned`/`drafting`/`live`) `priority` `source` `note` `search_volume`(预留) `difficulty`(预留) `current_rank`(预留) `rank_checked_at`(预留) `updated_at`✓

### 5.12 `ledgers/sku_media.csv`（★sku+image_role · 台账）
`sku,image_role,image_url,alt_text,source,width,height,updated_at`
- **手动首图** = `image_role=main` 的行；EDM 页"手动输入的首图 URL"读写这里
- `source`：`mailchimp`（域名含 mcusercontent.com / mailchimp）或 `cdn`

### 5.13 `ledgers/sku_tags.csv`（★sku · 台账）
`sku,tags,priority,exclude_edm,email_blurb,season,note,updated_at`；tags 小写 `;` 分隔；以产品为单位操作时写入该产品全部 active 变体

### 5.14 `ledgers/edm_campaigns.jsonl`（★campaign_id · 台账）
`campaign_id`★(`YYYY-MM-DD-slug`) `date`✓ `theme`✓ `status`✓(`draft`/`scheduled`/`sent`) `subject` `preheader` `audience` `handles`✓ `promo_code` `utm_campaign` `mailchimp_campaign_id` `send_date` + 预留：`recipients` `open_rate` `click_rate` `orders` `revenue`

### 5.15 `ledgers/outreach.jsonl`（★domain · 台账）
`domain`★ `added_at`✓ `status`✓ `linkflow_id` `topic` `note` `target_url` `live_link`

### 5.16 `views/products.jsonl`（★handle · 每日 · 生成）
`handle`★ `product_id` `title` `url` `category` `categories` `price_min` `price_max` `compare_at_max` `currency` `on_sale` `image_url` `image_source`(`feed`/`manual`/`none`) `feed_image_url` `manual_image_url` `variant_count` `skus` `in_stock_variants` `stock_status` `stock_since` `tags` `priority` `exclude_edm` `email_blurb` `last_featured` `days_since_featured` `is_new` `restocked_at` `price_dropped_at` `short_description` `rating` `review_count` `seo_issue_count` `units_30d`(预留) `revenue_30d`(预留) `sales_rank`(预留) `first_seen` `status`

**图片规则**（按 `edm.image_priority`，默认 feed → manual）：取产品第一个 active 变体的 feed `image_url`；为空则取任一变体的手动首图；都没有为 `none`。
**库存聚合**：任一变体有货即 `in_stock`，否则 `preorder` > `out_of_stock` > `unknown`。

### 5.17 `views/sku_stock.jsonl`（★sku · 每日 · 生成）
`sku`★ `title` `variant_title` `category` `price` `stock_status` `since` `days_in_status` `online_rate_7d` `online_rate_30d` `history_30d` `changes_30d` `last_change` `last_change_at`
- `history_30d`：30 个字符，最旧在左，每天一个：`i` 有货 / `o` 缺货 / `p` 预售 / `u` 未知 / `-` 未上架；由 events + latest 回推
- `online_rate_*` = 有货天数 / 在售天数（`-` 不计入分母）

### 5.18 `logs/runs.jsonl`（★run_id）
`run_id`★(`{date}-{job}`) `job`✓ `trigger`(`schedule`/`manual`/`cli`) `device_name` `started_at`✓ `finished_at` `status`✓(`ok`/`partial`/`failed`/`skipped`) `counts` `errors`

### 5.19 `logs/validation.json`
```json
{
  "checked_at": "2026-10-20T02:30:04-07:00", "trigger": "schedule",
  "summary": {"total": 22, "ok": 18, "error": 2, "missing": 1, "conflict_copy": 1},
  "files": [
    {"path": "index/seo/links.jsonl", "kind": "sync", "status": "error", "rule": "parse",
     "message": "第 212 行 JSON 不完整", "line": 212, "records": null, "size": 24576,
     "modified_at": "…", "repair": "regenerate:weekly.links"}
  ]
}
```
`kind`：`sync` `ledger` `config` `view` `doc`；`status`：`ok` `error` `missing` `conflict_copy`；`repair`：`regenerate:{job}.{step}` / `autofix` / `restore_archive` / `delete_copy` / `null`

### 5.20 `design/tokens.json`、`site/sitemaps.json`、`site/tech.json`
同 v1.0（见 `schemas/`），tokens 增加 `email_safe: {font_stack, button_color}`。

## 6. 数据校验规则（validate）

| 规则 id | 检查 |
|---|---|
| `missing` | 必需文件不存在 |
| `parse` | JSON / JSONL / CSV 解析失败（给出行号） |
| `schema` | 字段类型、枚举、必填（ajv） |
| `header` | CSV 表头与规范不一致 |
| `pk_duplicate` | 主键重复 |
| `sort` | 未按主键排序 |
| `ref` | 引用不存在的 SKU（latest、ledgers） |
| `conflict_copy` | 同目录存在云盘冲突副本（文件名含 冲突 / conflict / 副本 / `(1)` 等，可在设置补充模式） |
| `stale` | daily 超过 36 小时未成功（项目级） |
| `readme_markers` | README 自动区块标记不成对 |

修复映射：

| 文件 | repair |
|---|---|
| catalog/skus、inventory/* | `regenerate:daily`（用最新 feed 重跑；保护阈值仍生效） |
| seo/*、content/blog_index、catalog/product_details、catalog/categories | `regenerate:weekly.{step}` |
| views/* | `regenerate:views` |
| README.md | `regenerate:readme` |
| ledgers/*、content/keywords | 格式/排序问题 `autofix`；内容损坏 `restore_archive`（从最近月度归档恢复） |
| 冲突副本 | `delete_copy`（移到回收站） |

## 7. README 区块
标记：`<!-- siteindex:auto:start id="…" -->` … `<!-- siteindex:auto:end id="…" -->`；软件只替换标记之间内容，标记外逐字节保留；缺失区块追加到末尾，`readme.disabled_blocks` 中的不追加。
区块：`index-summary` `task-routing` `data-guide` `design-summary` `changelog`。模板见 `templates/project/README.md`，目标样例见 `templates/examples/README.generated.md`。

## 8. 工作目录（已取消管理）
软件不再创建默认工作区文件夹，也不再读写 `_about.md`。已有项目中的这些文件夹与文件原样保留；README 中残留的 `folder-map` 标记保留但不再填充，`readme_markers` 校验不因此报错。

## 9. 与参考实现（1.0）的路径对照

| 1.0（reference/） | 1.1 |
|---|---|
| `site.json` | `index/site.json` |
| `catalog/pages.jsonl` | `index/seo/pages.jsonl`（字段扩充） |
| `catalog/*`、`inventory/*`、`content/*` | `index/` 下同名 |
| `enrich/sku_media.csv` | `index/ledgers/sku_media.csv`（含义改为手动首图，增加 width/height） |
| `enrich/sku_tags.csv` | `index/ledgers/sku_tags.csv`（增加 email_blurb/season） |
| `edm/index.jsonl` | `index/ledgers/edm_campaigns.jsonl` |
| `outreach/contacted.jsonl` | `index/ledgers/outreach.jsonl` |
| `views/products.jsonl` | `index/views/products.jsonl`（图片规则改为 feed 优先） |
| `logs/runs.jsonl`、`reports/*` | `index/` 下同名 |

`fixtures/expected/` 是 1.0 参考实现的输出（已映射到新路径）。1.1 新增字段与表（seo/issues、links、product_details、sku_stock、validation、categories 规则、image 规则）没有黄金输出，由 Core 工作流按本规范实现并补充测试。
