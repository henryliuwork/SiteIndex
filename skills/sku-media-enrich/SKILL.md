---
name: sku-media-enrich
version: 1.0.0
description: 把用户上传到 Mailchimp 等处的产品图片 URL 匹配到 SKU，写入图片台账；维护产品主题标签、推荐优先级与 EDM 排除标记。用户给出图片 URL 列表或要求给产品打标签/设优先级/排除时使用。
---

# sku-media-enrich

工作目录为项目根目录。数据：`index/catalog/skus.jsonl`（sku、handle、title、variant_title、status）。

## A. 图片
匹配顺序：精确 SKU（忽略大小写与 `-` `_` 空格）→ 精确 handle（写入该产品全部 active 变体）→ 文件名包含唯一 sku/handle → 其余列为"未匹配"。一对多或多对一且无法判断角色的列为"待确认"，不写入。

`image_role`：默认 `main`；文件名含 alt/2/back → `alt`；含 life/scene/model → `lifestyle`。`source`：域名含 mcusercontent.com 或 mailchimp → `mailchimp`，否则 `cdn`。`alt_text` 默认产品标题。

```bash
siteindex ledger upsert . sku_media --rows .tmp/media.jsonl
```
每行：`{"sku","image_role","image_url","alt_text","source"}`

## B. 标签与优先级
`tags` 小写、`;` 分隔，与已有值合并（先读 `index/ledgers/sku_tags.csv`）；`priority` 1–5；`exclude_edm` 0/1。以产品为单位的规则写入全部 active 变体。
```bash
siteindex ledger upsert . sku_tags --rows .tmp/tags.jsonl
```

## 交付
写入条数、未匹配清单、待确认清单；`siteindex views .` 后统计有货产品中 `image_source=mailchimp` 的比例。
