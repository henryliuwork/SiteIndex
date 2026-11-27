---
name: sku-media-enrich
version: 1.2.0
description: 维护产品标签与 EDM 优先级；商品手动首图交给 siteindex-edm-manual-image。
reads:
  - README.md
  - index/catalog/skus.jsonl
  - index/ledgers/sku_tags.csv
  - index/views/products.jsonl
writes:
  - index/ledgers/sku_tags.csv
---

# sku-media-enrich

先遵循 siteindex-data 的数据格式与不编造规则。本 Skill 只维护产品标签、优先级等标签台账字段。收到“设置/更换商品首图”请求时，使用 `siteindex-edm-manual-image`；不得在本 Skill 中直接写入 `sku_media.csv`。

## 读哪些数据

读取当前项目 `skus.jsonl` 的 sku、handle、title、variant_title、status，以及现有 `sku_tags.csv`。workspace 项目按 `_site-index/workspace.json` 的路径映射定位数据，legacy 项目使用 `index/`。写入后可读取 `products.jsonl` 核对聚合结果。

## 如何筛选判断

- 按用户明确给出的 SKU、handle 或唯一产品名称定位；多个匹配或没有匹配时列为待确认，不猜。
- tags 用小写分号分隔；priority 范围为 1–5，exclude_edm 为布尔值。按产品级修改标签时同步其全部 active 变体，并保留无关字段。
- 没有数据中的 SKU 或用户确认信息时停止该项，不用相似商品补齐。

## 写哪些台账

仅按 SKU 合并更新 `index/ledgers/sku_tags.csv` 的 tags、priority、exclude_edm、email_blurb、season、note；保留其他列及现有值。优先使用 `siteindex ledger upsert`；不可用时按 DATA_SPEC §5.13 的列顺序和主键处理，CSV 使用 UTF-8 无 BOM、LF、主键升序。向用户报告新增、更新、未匹配和待确认条目数。
