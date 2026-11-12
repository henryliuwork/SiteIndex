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
│   ├── edm/         ← 用户或 EDM 技能管理的导出文件
│   ├── reports/     daily/YYYY-MM-DD.md · weekly/YYYY-Www.md
│   ├── archive/     YYYY-MM/*.gz
│   └── logs/        runs.jsonl · validation.json · jobs/{runId}.log
└── …                              ← 用户自己的工作目录（软件不创建、不读写）
```
本机缓存（不进云盘）：`{cache_dir}/{projectId}/index.db`、`{cache_dir}/{projectId}/ui-state.json`

workspace 布局使用 `_site-index/` 替代上图的 `index/`；`_site-index/edm/` 由 EDM 技能/用户维护。SKU 清单导出通过 Desktop 原生另存对话框交给用户选择保存位置，不再写入项目内的固定 canonical 路径。

## 2. 写入权限

| 路径 | 写入方 |
|---|---|
| `index/`（下列台账除外） | 仅 SiteIndex（执行设备的定时任务，或用户手动触发） |
| `index/edm/*`、`_site-index/edm/*` | 用户或 EDM 技能；SiteIndex 的清单导出不会写入项目内固定路径 |
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
- Core 数据写入为原子写（临时文件 → fsync → rename，Windows 占用重试）。EDM Save As 遵循 §3.1 的 no-clobber / 条件更新规则，不通过 Core 的通用原子写接口接收或写入用户选择的路径。

### 3.1 EDM SKU 清单（生成的 Markdown）

- `edm.exportIndex(projectId)` 只接收项目 ID，不接受 SKU 子集、文件名或输出路径。Core 按对应布局读取 `views/products`、`ledgers/sku_media` 与 `ledgers/sku_tags`，确定性渲染完整清单并把内容与统计交给 Desktop；Core 不写导出文件。
- CLI 使用独立命令 `siteindex edm export-index <project> --output <path>`；必须由调用方显式提供输出路径，缺失路径时返回参数错误且不写入。CLI 调用 Core 的只读 renderer 后只创建新文件，不覆盖任何已有文件；目标已存在且字节相同时返回 unchanged、不重写，内容不同时返回 `EDM_INDEX_CONFLICT` 并保留原文件。临时文件和 no-clobber 发布必须在目标同一目录；平台不能确认独占发布时拒绝写入。该 CLI 路径策略不改变 Desktop 的原生另存契约。
- Desktop 主进程打开原生另存对话框并负责保存。renderer 不提供路径、不接收 Markdown 内容或绝对路径；新 bridge 成功结果只向 renderer 返回不含路径分隔符的文件 basename、SKU 计数和待补图计数。`created` 表示目标此前不存在并以 no-clobber 方式创建；`updated` 表示项目目录外的已有目标已获原生覆盖确认并安全更新；`unchanged` 表示目标内容已与渲染内容相同且无需重写。取消保存对话框或系统覆盖确认时返回 `status: "cancelled"`，不得显示成功提示。
- 用户项目目录内的已有文件一律不得被覆盖；若选择了项目目录内的已有目标，返回 `EDM_INDEX_CONFLICT` 并保留原文件。用户可在项目目录内选择一个不存在的新目标，但必须先确认规范化真实目标仍位于项目根目录内、路径祖先均安全，并用 no-clobber 原语创建；任一项无法确认就拒绝写入。项目目录外的已有目标只有在原生覆盖确认完成后才可更新。保存前后若目录身份、目标类型或目标状态发生变化，或实现无法安全确认写入结果，必须 fail closed 并保留现有文件；不能依靠字符串路径前缀判断项目目录，也不能用普通“检查后无条件 rename”声称消除了 symlink/junction、目录替换或并发竞态。平台/同步盘无法提供经过验证的 no-clobber 或条件替换语义时，应拒绝写入。
- 文件首行是 `<!-- siteindex:generated:edm-sku-index:v1 -->`，其后为 `# EDM SKU Index` 标题、空行、Markdown 表格；表头顺序固定为 `SKU | 标题 | 短描述 | URL | 图片 URL | 原价 | 折扣价 | 库存`，随后一行使用相同列数的 `---` 分隔符。单元格先将 `\` 写为 `\\`，再将 `|` 写为 `\|`，CR/LF 换行写为 `<br>`；null/缺值为空单元格。金额使用不带千位分隔符和货币符号的十进制数，URL 使用规范化 HTTP(S) 地址。
- 按父 SKU 聚合时使用 roadmap §4.4 规定的代表子 SKU；图片优先使用 `image_role=main` 的台账图片，其次使用 feed 首图。EDM 清单排除 WebP；无可用图时写“待补图”。短描述来自 `sku_tags.email_blurb`。
- `edm.discount_tiers` 是用户可选的百分比档位数组，元素必须是互不重复的整数 `1..99`；省略或空数组表示未启用折扣。每个 canonical 导出行必须单独选择其中一个档位；不推断、不按行顺序分配，也不自动采用最高/最低档。选择值保存在 `sku_tags.discount_tier`，其 CSV 列追加在 `updated_at` 后。缺少该列、缺少记录、空值或 null 都表示未选择，输出“折扣价”空单元格；旧台账无需迁移即可读取。未配置的值或不是整数 `1..99` 的值在已有台账中按未选择处理；通过 `edm.setDiscountTier` 写入不存在于配置列表中的值时返回 `EDM_DISCOUNT_TIER_INVALID`，不修改文件。配置数组含重复项、非整数或越界项时按 `CONFIG_INVALID` 处理。
- 普通导出行的选择键为真实 SKU；父子分组导出行的选择键为确定性生成的父 SKU。父行读取并写入父键自己的档位，明确取代“沿用代表子 SKU 档位”的旧草案；不得从任何子 SKU 继承，也不得向子 SKU 批量传播。规则变化后暂时不再生成的父键台账行应保留并报告为失联引用，不得由自动整理删除；再次生成同一父键时恢复使用。父键只作为清单行键，不创建虚拟库存。清除选择使用 null。UI 选择入口属于 D 的 `EdmPage`，使用项目配置列出档位并通过可选的 `edm.setDiscountTier` 保存；旧 bridge 不提供该方法时必须禁用选择并保持只读。
- 折扣价以当前 feed 有效售价 `price` 为基数（包括 feed 当前有效的 `sale_price`），按 `price * (100 - discount_tier) / 100` 计算；已有效的 feed sale 仍作为当前售价继续计算此档，不回退到 `compare_at_price`。父行使用既定代表子 SKU 的当前有效售价。每个导出行的 `site.json.currency` 与所用 SKU 的 `currency` 必须是已知 ISO 4217 字母代码并一致（大小写归一后比较）；任一导出行未知、缺失或不一致时，整个 render/export 以 `EDM_CURRENCY_INVALID` 失败且不生成/替换目标文件。Core 使用固定的 ISO 4217 币种小数位表；支持 0、2、3 位，其他或未知币种 fail closed。原价与折扣价都格式化为对应的固定小数位（例如 JPY `1250`、USD `12.50`、KWD `12.500`），不带符号或千分位。折扣乘法采用十进制精确计算，在目标币种最小单位上按 half-up 舍入（非负中点进位）；不得用二进制浮点格式化决定结果。
- 同一份输入必须产生字节一致的清单：SKU 字典序按 `compareKeys`，不含生成时间、不依赖本机 locale、用户保存位置或遍历顺序；UTF-8 无 BOM、LF、末尾一个换行。用户选定目标后，若已有文件字节已与渲染结果一致则返回 `unchanged` 且不重写；新建目标返回 `created`，实际替换已有目标返回 `updated`。
- 写入可能已经完成但 Desktop IPC 确认丢失时返回 `EDM_EXPORT_OUTCOME_UNKNOWN`（中文 message：“清单写入结果暂无法确认，可重新生成以核对。”）；调用方不得把它当作“未写入”或自动盲目重试。目标占用或无权限等确认未写入错误使用 `WRITE_FAILED`；所有错误 message/detail 不得泄露绝对路径、凭据或原始服务响应。旧 bridge 返回的 `path` 仅为迁移兼容，新 bridge 不返回该字段。

### 3.2 EDM media Job 的历史恢复字段

- 新 media Job 的最终 `JobResult` 与 `RunLog` 记录请求 SKU（去重后保持请求顺序）、`media_batch_state`、已确认的 `media_results`、结果未知 SKU、确认未开始 SKU，以及可选的 `WP_AUTH_FAILED` / `WP_FORBIDDEN` 批次错误码。
- 三组 SKU 必须无重叠且完整分区请求列表：`media_results[].sku`、`media_unknown_skus`、`media_not_started_skus`；每组成员各自保持请求顺序。`complete` 表示每个请求 SKU 都有已确认结果；`interrupted` 表示批次提前结束、未完成项均能确认尚未开始；`outcome_unknown` 表示至少一个 SKU 无法确认是否已开始处理或其外部副作用结果。`outcome_unknown` 时不能把不确定项报告为失败或未开始。
- 401/403 停批时，失败 SKU 保留在已确认结果中，`media_error_code` 说明原因，后续且能确认未开始的 SKU 列入 `media_not_started_skus`。硬退出时只保存有持久证据的完成结果；无法确认是否开始或是否成功的 SKU 列入 `media_unknown_skus`。若没有可靠进度检查点，全部未能确认的请求都标未知，不凭数组缺项推断未开始。
- `jobs.history(projectId)` 只返回该项目的记录，media 字段写回原项目 `runs.jsonl`。旧 `RunLog` 没有这些可选字段时表示结果不可恢复，不等于空结果；读取时不迁移或重写旧行。
- shared 的 `isValidMediaSkuRecoveryPartition(value)` 直接接收 `JobResult` 或 `RunLog` 原对象，并读取 `media_requested_skus`、`media_batch_state`、`media_results`、`media_unknown_skus`、`media_not_started_skus`，调用方无需改名映射；缺少字段的旧记录返回 `false`。验证器只检查对象/数组/字段类型、枚举和 SKU 分区结构，不证明外部操作的真实结果，也不证明 `reason` / `image_url` 已脱敏，脱敏责任仍在产生实时结果与历史记录的实现层。
- `reason`、`errors`、`summary` 不得包含 WordPress 用户名/口令、Authorization、凭据、原始认证响应或本机绝对路径。`image_url` 仅返回无 userinfo 和凭据参数的 HTTP(S) 地址；无法确认安全时省略。脱敏必须同时覆盖实时事件和持久历史。

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
`date`★ `sku`★ `type`★(`stock_change`/`price_change`/`new_sku`/`removed_sku`/`restored_sku`/`feed_anomaly`) `from` `to` `category`✓ `title`✓
- `feed_anomaly`：本次成功且完整的 feed 未包含仍 active 的 SKU，但产品页核验判断为有货；作为库存事件保存，不写入 SEO 问题。Core 通过 `inventory.summary.today[]` 返回 `type: "feed_anomaly"` 供界面消费。

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
- `source`：`mailchimp`（域名含 mcusercontent.com / mailchimp）、`cdn` 或 `wordpress`
- 兼容旧版 8 列表头；可选的 `media_id`、`source_hash` 只追加在表尾。读取旧台账时不改写文件；首次写入时才把表头扩展为 `sku,image_role,image_url,alt_text,source,width,height,updated_at,media_id,source_hash`，保留所有旧列值，新列对旧行留空。
- `media_id` 为 WordPress 媒体 ID；`source_hash` 为原始图片内容指纹，用于同 SKU、同源图的重试去重。凭据不得写入此台账。

### 5.13 `ledgers/sku_tags.csv`（★sku · 台账）
旧表头为 `sku,tags,priority,exclude_edm,email_blurb,season,note,updated_at`；V2 表头只在末尾追加 `discount_tier`。读取与校验必须接受这两个精确表头；旧表头等价于每行 `discount_tier=null`。`discount_tier` 为可选整数 `1..99`，并且在该项目 `edm.discount_tiers` 中配置。任何新建或修改写入（包括 upsert、删除后重写、autofix 整理）均输出 V2，保留已存在的档位值；从旧表升级时末列为空。不能识别的表头应报错并保持原文件，不可通过 autofix 丢弃未知列。旧版软件不会保留 V2 新列，用户若要保留选档，应避免用不支持该列的旧版软件写入台账。

普通行的 `sku` 键为实际 feed SKU；父行折扣选择使用 `sku_grouping` 当前规则确定性生成的父 SKU 键，校验引用时须承认当前有效父键。父键不是库存 SKU，不得据此创建 SKU、库存行或价格历史。过期父键行必须保留并作为失联引用提示，自动整理不得删除其中的折扣档位。tags 小写 `;` 分隔；以产品为单位操作时写入该产品全部 active 变体

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
- `inventory.listSkus` 的 `parent_only` 展示模式：仅在 `sku_grouping.enabled=true` 时，根据子 SKU 的 `parent_sku` 临时合成父行，并保留未归组的独立 SKU。父行只存在于查询结果，不写入本文件，不作为库存实体，也不重复计入 `inventory.summary` 的 SKU 总量或汇总在线率。分类取子项众数（并列按 `compareKeys`），价格取子项最低价；搜索子 SKU 可命中父行。
- 父行 `stock_status` 与 `history_30d` 按子 SKU 状态聚合：逐日忽略子项的 `-`；若当天没有任何已上架子项，结果为 `-`；否则任一子项为 `i`，结果为 `i`；所有可用子项均为 `o`，结果为 `o`；否则任一子项为 `p`，结果为 `p`；其余结果为 `u`。当前 `stock_status` 对子项当前状态使用同一优先级。
- 父行 `online_rate_7d` / `online_rate_30d` 从聚合后的 `history_30d` 计算：分子为 `i` 天数，分母为非 `-` 天数，因此 `o`、`p`、`u` 都计入分母；窗口内没有非 `-` 天时为 `null`。
- 父行 `changes_30d`、`last_change`、`last_change_at` 从聚合后的每日状态变化计算：只统计前后两天都不是 `-` 且状态不同的相邻日；上架/恢复上架边界不计为状态变化。没有此类变化时 `last_change` 与 `last_change_at` 为 `null`。
- 当前 Core 对合成父行返回 `since = asOf`、`days_in_status = 0`；这两个值没有从聚合历史推导，不表示父级当前状态实际开始日期或已持续天数。界面与调用方不得将其作为父级状态持续时长展示；若需该语义，须另行定义和实现。

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
