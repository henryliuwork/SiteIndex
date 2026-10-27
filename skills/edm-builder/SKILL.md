---
name: edm-builder
version: 1.1.0
description: 根据活动主题从 SiteIndex 产品数据中筛选商品、撰写 EDM 文案并登记 campaign。用户要求写邮件、EDM 或 campaign 时使用。
reads:
  - README.md
  - index/site.json
  - index/views/products.jsonl
  - index/ledgers/edm_campaigns.jsonl
writes:
  - index/ledgers/edm_campaigns.jsonl
---

# edm-builder

先遵循 siteindex-data 的数据格式与不编造规则。

## 读哪些数据

读取 README 的品牌语气和工作规则，index/site.json 的 edm.max_products、edm.cooldown_days、edm.platform、edm.image_priority，index/views/products.jsonl 的产品视图，以及 index/ledgers/edm_campaigns.jsonl 的历史推品记录。

## 如何筛选判断

1. 主题、产品数、折扣码、截止日和 CTA 缺失时先向用户确认；产品数默认取配置的 edm.max_products。
2. 只考虑 status=active、stock_status=in_stock、exclude_edm=false 的产品；按 edm_campaigns 中最近 campaign 检查冷却期。
3. 按主题相关的 tags 命中优先，其次 title/category，再参考 priority；促销主题可优先考虑 on_sale。仅根据字段本身判断，不推测促销、库存或价格。
4. 图片按配置优先级选用。默认 feed 首图优先，其次手动首图；两者都没有则不进入 EDM。图片 URL 必须逐字取自产品视图。
5. 候选不足时说明缺货、冷却期或无匹配原因，不以无关产品补数。文案不承诺未确认的折扣、库存数量、运费或功效。

## 写哪些台账

活动内容与 HTML 交付给用户，存放位置按 README「工作规则与偏好」或用户当次指定；未指定时不要创建固定输出目录。仅在活动开始需要登记或用户确认 campaign 时，按 campaign_id 合并更新 index/ledgers/edm_campaigns.jsonl。字段和格式见 siteindex-data 与 DATA_SPEC §5.14；未知 campaign id、日期、发送状态或 handles 不得猜测。
