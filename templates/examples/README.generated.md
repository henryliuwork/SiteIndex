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
- 工作成果放入对应工作区文件夹，不要写入 `index/`（台账除外，见下方数据指南）
- 数据缺失或冲突时停下来询问，不要编造 SKU、价格、库存、图片 URL

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

今日日报：[`index/reports/daily/2026-10-21.md`](index/reports/daily/2026-10-21.md) · 看板：[`index/dashboard.html`](index/dashboard.html)
<!-- siteindex:auto:end id="index-summary" -->

<!-- siteindex:auto:start id="folder-map" -->
## 目录地图

| 文件夹 | 用途 | 文件数 | 最近修改 |
|---|---|---:|---|
| `seo/` | 关键词研究、排名周报、站内优化记录 | 24 | 2026-10-19 |
| `edm/` | 每次 campaign 一个子文件夹（brief、content.json、email.html） | 31 | 2026-10-20 |
| `产品/` | 产品图、上新资料、利润测算 | 112 | 2026-10-18 |
| `内容/` | 博客 brief 与草稿（`drafts/`），已发布文章存档 | 40 | 2026-10-15 |
| `设计/` | _待补充说明_ | 8 | 2026-09-30 |
| `报告/` | 月度钉钉汇报、复盘 | 9 | 2026-10-01 |
| `index/` | 网站数据库（SiteIndex 维护，见下方数据指南） | — | 2026-10-21 |
| `_agent/` | agent skills（SiteIndex 分发） | 8 | 2026-10-20 |

> 说明来自各文件夹的 `_about.md` 第一段。标注"待补充说明"的文件夹请补充 `_about.md`。
<!-- siteindex:auto:end id="folder-map" -->

<!-- siteindex:auto:start id="task-routing" -->
## 任务路由

| 任务 | Skill | 读取 | 产出 |
|---|---|---|---|
| 写 EDM | `_agent/skills/edm-builder/SKILL.md` | `index/views/products.jsonl`、`index/ledgers/edm_campaigns.jsonl` | `edm/{date}-{slug}/` |
| 录入图片 / 打标签 | `_agent/skills/sku-media-enrich/SKILL.md` | `index/catalog/skus.jsonl` | `index/ledgers/sku_media.csv`、`sku_tags.csv` |
| 库存汇报 | `_agent/skills/stock-report/SKILL.md` | `index/reports/daily/`、`index/inventory/` | 回复 / `报告/` |
| 写博客 | `_agent/skills/blog-writer/SKILL.md` | `index/content/`、`index/catalog/pages.jsonl`、`index/views/products.jsonl` | `内容/drafts/` |
| 外链搜集 | `_agent/skills/link-prospect/SKILL.md` | `index/ledgers/outreach.jsonl` | linkflow + `index/ledgers/outreach.jsonl` |
| 页面 / 视觉设计 | `_agent/skills/page-design/SKILL.md` | `index/design/` | `设计/` |
| 补充项目说明 | `_agent/skills/project-readme/SKILL.md` | 工作区文件夹 | `_about.md`、README 用户区块 |
<!-- siteindex:auto:end id="task-routing" -->

<!-- siteindex:auto:start id="data-guide" -->
## 数据指南（index/）

| 路径 | 内容 | 主键 | 写入 |
|---|---|---|---|
| `index/site.json` | 站点配置、品牌、抓取与 EDM 设置 | — | 用户 / SiteIndex |
| `index/catalog/skus.jsonl` | SKU 主表（一行一个变体） | sku | SiteIndex |
| `index/catalog/categories.json` | 分类树 | slug | SiteIndex |
| `index/catalog/pages.jsonl` | 首页、分类页、静态页 SEO | url | SiteIndex |
| `index/inventory/latest.jsonl` | 当前库存与持续天数 | sku | SiteIndex |
| `index/inventory/events/YYYY-MM.jsonl` | 到货、缺货、调价、上新、下架事件 | date+sku+type | SiteIndex |
| `index/inventory/daily_summary.csv` | 每日分类库存汇总 | date+category | SiteIndex |
| `index/content/blog_index.jsonl` | 博客索引与内链 | url | SiteIndex |
| `index/content/keywords.jsonl` | 关键词 → 目标页面 | keyword | agent / 用户 |
| `index/ledgers/sku_media.csv` | Mailchimp 托管图片 | sku+image_role | agent / 用户 |
| `index/ledgers/sku_tags.csv` | 主题标签、优先级、EDM 排除 | sku | agent / 用户 |
| `index/ledgers/edm_campaigns.jsonl` | EDM 记录（推品冷却期） | campaign_id | agent / 用户 |
| `index/ledgers/outreach.jsonl` | 外链去重名单 | domain | agent / 用户 |
| `index/views/products.jsonl` | **产品级合并视图，选品首选** | handle | SiteIndex |
| `index/design/` | 设计规范 tokens、品牌视觉、截图 | — | SiteIndex |

写入台账：`siteindex ledger upsert kingsyard <ledger> --rows <file|->`。命令不可用时，严格按 `index/` 现有文件的格式与排序手写。
查询产品：`siteindex query kingsyard products --in-stock --tag halloween --json`
<!-- siteindex:auto:end id="data-guide" -->

<!-- siteindex:auto:start id="design-summary" -->
## 设计规范速览
_提取于 2026-10-01_

- 主色 `#2f5d3a` · 文字 `#222222` · 背景 `#ffffff` · 促销 `#c0392b`
- 标题字体 `Lora, serif` · 正文字体 `Inter, sans-serif`
- 主按钮：背景 `#2f5d3a`、白字、圆角 4px、内边距 12px 24px、字重 600

完整规范：`index/design/tokens.json`、`index/design/brand.md`
<!-- siteindex:auto:end id="design-summary" -->

<!-- siteindex:auto:start id="changelog" -->
## 变更记录

| 日期 | 事件 |
|---|---|
| 2026-10-21 | 每日同步：新缺货 5（tube-feeders 有货率降至 71%） |
| 2026-10-20 | Skill 更新：edm-builder 1.2.0 |
| 2026-10-14 | 配置修改：missing_as → out_of_stock |
| 2026-10-01 | 设计规范更新 |
| 2026-09-28 | 新建项目 |
<!-- siteindex:auto:end id="changelog" -->
