---
name: sku-media-enrich
version: 1.1.0
description: 将用户提供的产品图片 URL 匹配到 SKU 并写入手动图片台账，也可维护产品标签与 EDM 优先级。
reads:
  - README.md
  - index/catalog/skus.jsonl
  - index/ledgers/sku_media.csv
  - index/ledgers/sku_tags.csv
  - index/views/products.jsonl
writes:
  - index/ledgers/sku_media.csv
  - index/ledgers/sku_tags.csv
---

# sku-media-enrich

先遵循 siteindex-data 的数据格式与不编造规则。图片 URL 必须来自用户提供的资料或当前台账，不可从标题猜测或自行构造。

## 读哪些数据

读取 index/catalog/skus.jsonl 的 sku、handle、title、variant_title、status；读取现有 index/ledgers/sku_media.csv、index/ledgers/sku_tags.csv；写入后可读 index/views/products.jsonl 检查聚合结果。

## 如何筛选判断

- 匹配图片时依次尝试大小写与分隔符归一后的精确 SKU、精确 handle、用户提供文件名中的唯一 SKU/handle。多对多或不唯一匹配列为待确认，不写入。
- image_role 默认 main；只有用户提供的文件名或说明明确表达备用图/场景图时，才记录 alt 或 lifestyle。
- source 只依据真实托管 URL 域名判定：Mailchimp 域名记 mailchimp，其他已确认 CDN 记 cdn；无法确认时询问，不猜。
- tags 用小写分号分隔；priority 范围为 1–5，exclude_edm 为布尔值。按产品级修改标签时同步其全部 active 变体，并保留无关字段。
- 产品没有数据中的 SKU、图片 URL 或确认信息时停止该项，不用相似商品补齐。

## 写哪些台账

按 SKU 与 image_role 合并更新 index/ledgers/sku_media.csv；标签、priority、exclude_edm、email_blurb、season、note 合并更新 index/ledgers/sku_tags.csv。优先使用 siteindex ledger upsert；不可用时按 DATA_SPEC §5.12–§5.13 的列顺序和主键处理，CSV 使用 UTF-8 无 BOM、LF、主键升序。向用户报告新增、更新、未匹配和待确认条目数。
