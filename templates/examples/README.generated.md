# Kingsyard · 项目说明

> 本文件是 kingsyard.com 项目的总入口。任何 agent 接入时先完整阅读本文件。
> 「项目概况 / 当前重点 / 工作规则与偏好」由用户维护；带 `siteindex:auto` 标记的区块由 SiteIndex 自动生成，不要手动修改。

## 项目概况
Wild bird feeding supplies for backyard birders.

- 网站：https://www.kingsyard.com（magento）
- 目标市场：US
- 目标人群：Backyard bird lovers, gift buyers
- 文案调性：Warm, practical, nature-loving; short sentences

## 当前重点
- 10 月：Halloween / 秋季喂鸟季 EDM；补齐吸鸟指南类博客

## 工作规则与偏好
- 成果存放位置按本节约定或用户当次指定；SiteIndex 不管理项目工作目录。
- 仅将明确允许的台账写入 index/；数据缺失或冲突时停下来询问，不要编造 SKU、价格、库存、图片 URL。

<!-- siteindex:auto:start id="index-summary" -->
## 网站数据速览
_更新于 2026-10-21 02:04 · 每日同步：成功_

| 指标 | 数值 |
|---|---|
| 在售 SKU / 产品 | 486 / 312 |
| 有货率 | 87.4%（较 7 天前 −2.1pt） |
| 分类 | 14 |
| 博客文章 | 63 |
| 今日变化 | 新到货 3 · 新缺货 5 · 调价 2 · 上新 1 |

今日日报：index/reports/daily/2026-10-21.md
<!-- siteindex:auto:end id="index-summary" -->

<!-- siteindex:auto:start id="task-routing" -->
## 任务路由

| 任务 | Skill | 读取 | 台账 / 交付 |
|---|---|---|---|
| 写 EDM | _agent/skills/edm-builder/SKILL.md | index/views/products.jsonl、index/ledgers/edm_campaigns.jsonl | campaign 台账；文件位置由本节约定或用户指定 |
| 录入图片 / 打标签 | _agent/skills/sku-media-enrich/SKILL.md | index/catalog/skus.jsonl | index/ledgers/sku_media.csv、sku_tags.csv |
| 库存汇报 | _agent/skills/stock-report/SKILL.md | index/reports/daily/、index/inventory/ | 回复；保存位置由用户指定 |
| 写博客 | _agent/skills/blog-writer/SKILL.md | index/content/、index/seo/pages.jsonl、index/views/products.jsonl | 关键词台账；草稿位置由用户指定 |
| 外链搜集 | _agent/skills/link-prospect/SKILL.md | index/ledgers/outreach.jsonl | LinkFlow + index/ledgers/outreach.jsonl |
| 页面 / 视觉设计 | _agent/skills/page-design/SKILL.md | index/design/ | 交付位置由用户指定 |
| 更新项目说明 | _agent/skills/project-readme/SKILL.md | README 用户区块 | README 用户区块 |
| 查询与数据规则 | _agent/skills/siteindex-data/SKILL.md | index/ 与 DATA_SPEC.md | 仅允许的 index 台账 |
<!-- siteindex:auto:end id="task-routing" -->

<!-- siteindex:auto:start id="data-guide" -->
## 数据指南（index/）

| 路径 | 内容 | 主键 | 写入 |
|---|---|---|---|
| index/site.json | 站点配置、品牌、抓取与 EDM 设置 | — | 用户 / SiteIndex |
| index/catalog/skus.jsonl | SKU 主表（一行一个变体） | sku | SiteIndex |
| index/catalog/product_details.jsonl | 产品页详情 | handle | SiteIndex |
| index/catalog/categories.json | 分类树 | slug | SiteIndex |
| index/inventory/latest.jsonl | 当前库存状态 | sku | SiteIndex |
| index/inventory/events/YYYY-MM.jsonl | 库存、价格与商品变化 | date + sku + type | SiteIndex |
| index/inventory/daily_summary.csv | 每日分类库存汇总 | date + category | SiteIndex |
| index/seo/pages.jsonl | 全部 SEO 页面 | url | SiteIndex |
| index/seo/issues.jsonl | SEO 问题 | url + rule | SiteIndex |
| index/seo/links.jsonl | 站内链接 | from + to + anchor | SiteIndex |
| index/content/blog_index.jsonl | 博客索引 | url | SiteIndex |
| index/content/keywords.jsonl | 关键词映射 | keyword | agent / 用户 |
| index/ledgers/sku_media.csv | 手动首图 | sku + image_role | agent / 用户 |
| index/ledgers/sku_tags.csv | 主题标签、优先级、EDM 排除 | sku | agent / 用户 |
| index/ledgers/edm_campaigns.jsonl | EDM 记录 | campaign_id | agent / 用户 |
| index/ledgers/outreach.jsonl | 外链去重名单 | domain | agent / 用户 |
| index/views/products.jsonl | 产品聚合视图 | handle | SiteIndex |
| index/views/sku_stock.jsonl | SKU 库存视图 | sku | SiteIndex |

SiteIndex 提供查询和台账命令；字段与格式见项目内 DATA_SPEC.md 及 siteindex-data skill。
<!-- siteindex:auto:end id="data-guide" -->

<!-- siteindex:auto:start id="design-summary" -->
## 设计规范速览
_提取于 2026-10-01_

- 主色 #2f5d3a · 文字 #222222 · 背景 #ffffff · 促销 #c0392b
- 标题字体 Lora, serif · 正文字体 Inter, sans-serif
- 主按钮：背景 #2f5d3a、白字、圆角 4px、内边距 12px 24px、字重 600

完整规范：index/design/tokens.json、index/design/brand.md
<!-- siteindex:auto:end id="design-summary" -->

<!-- siteindex:auto:start id="changelog" -->
## 变更记录

| 日期 | 事件 |
|---|---|
| 2026-10-21 | 每日同步：新缺货 5（tube-feeders 有货率降至 71%） |
| 2026-10-20 | Skill 更新：edm-builder 1.1.0 |
| 2026-10-14 | 配置修改：missing_as → out_of_stock |
| 2026-10-01 | 设计规范更新 |
| 2026-09-28 | 新建项目 |
<!-- siteindex:auto:end id="changelog" -->
