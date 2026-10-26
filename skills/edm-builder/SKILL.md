---
name: edm-builder
version: 1.0.0
description: 根据主题为当前网站项目选品并生成可直接粘贴到 Mailchimp（或其他邮件工具）的 EDM HTML，并登记推品记录。用户说"写一封 XX 主题的邮件/EDM/campaign"时使用。
reads:
  - README.md
  - index/site.json
  - index/views/products.jsonl
  - index/ledgers/edm_campaigns.jsonl
writes:
  - edm/
  - index/ledgers/edm_campaigns.jsonl
---

# edm-builder

工作目录为项目根目录（含 README.md）。先读 README.md 的「项目概况」「工作规则与偏好」。

## 1. 确认需求

未提供时询问：主题、产品数量（默认 `index/site.json → edm.max_products`）、折扣码与截止日、CTA 链接。

## 2. 选品

```bash
siteindex query . products --in-stock --json > .tmp/candidates.json
```

命令不可用时直接读 `index/views/products.jsonl`。

硬性条件：`status=active`、`stock_status=in_stock`、`exclude_edm=0`、`days_since_featured` 为 null 或 ≥ `edm.cooldown_days`。

排序得分：`tags` 命中主题 +3；`title`/`category` 命中 +2；`priority`/2；促销主题且 `on_sale` +1。取前 N。

图片硬规则：feed 首图优先 → 手动首图 → 都没有则不进入 EDM。使用 `image_source=feed` 的 feed 图片；没有 feed 图片时使用 `image_source=manual` 的手动首图。`image_source=none` 或图片 URL 为空的产品不入选。若 `edm.platform=mailchimp` 且用户反馈外部图片显示异常，列出这些产品，请用户上传到 Mailchimp 后用 sku-media-enrich 录入。

候选不足时说明原因（缺货/冷却期/无匹配），不要用不相关产品凑数。

## 3. 撰写

目录：工作区 `edm/{YYYY-MM-DD}-{slug}/`。

`brief.md`：主题、受众、选品逻辑、入选与落选原因。

`content.json`：

```json
{
  "campaign_id": "2026-10-20-halloween",
  "subject": "≤50字符",
  "preheader": "≤90字符",
  "headline": "…",
  "intro": "1–3句，可含<br>",
  "products": [{ "handle": "…", "blurb": "≤20词，可选" }],
  "cta_text": "…",
  "cta_url": "https://…",
  "closing": "可选",
  "promo_code": "可选",
  "promo_note": "可选"
}
```

文案遵循 `brand.voice`；不写未经确认的折扣、库存数量、运费承诺。

## 4. 渲染与登记

```bash
siteindex edm render . edm/{campaign_id}
echo '{"campaign_id":"…","date":"YYYY-MM-DD","theme":"…","status":"draft","handles":["…"]}' | siteindex ledger upsert . edm_campaigns --rows -
```

价格、图片、链接由渲染器从数据读取并自动加 UTM，不要手写到 HTML。

## 5. 交付

subject、preheader、产品清单（标题 · 价格 · 库存），`email.html` 路径。用户告知排期/发送后，更新台账 `status`、`send_date`、`mailchimp_campaign_id`。

## CLI 不可用时

直接读取 `index/views/products.jsonl`，按上面的库存、冷却期和图片规则筛选；不要仅因 feed 图片缺失而跳过仍有手动首图的产品。渲染邮件时从产品数据取价格、图片与链接。登记 campaign 时按 DATA_SPEC §5.14 以 campaign_id 合并 `index/ledgers/edm_campaigns.jsonl`，保留 schema 字段顺序，按 campaign_id 升序写 UTF-8 无 BOM、LF 的 JSONL；邮件文件写入 README 路由指定的 edm 工作区。
