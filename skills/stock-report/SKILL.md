---
name: stock-report
version: 1.0.0
description: 读取当前网站项目的库存日报、事件与汇总，回答库存问题，生成日报/周报/趋势分析。用户问"今天哪些缺货/到货""这周库存怎么样""某分类缺货趋势"时使用。只读。
reads:
  - index/logs/runs.jsonl
  - index/reports/daily/
  - index/inventory/events/
  - index/inventory/daily_summary.csv
  - index/inventory/latest.jsonl
  - index/catalog/skus.jsonl
  - index/views/products.jsonl
  - index/ledgers/edm_campaigns.jsonl
writes: []
---

# stock-report

工作目录为项目根目录。本 skill 不修改任何文件。

## 先检查数据新鲜度

读 `index/logs/runs.jsonl` 最后一条 `job=daily`：不是今天或 `status=failed` → 先告知用户并说明 `errors`，再基于最近成功数据回答；`partial` → 提示可能不完整。

## 数据源

| 问题               | 读取                                                                 |
| ------------------ | -------------------------------------------------------------------- |
| 今天/某天          | `index/reports/daily/{date}.md`                                      |
| 一段时间           | `index/inventory/events/YYYY-MM.jsonl` 按 date 过滤                  |
| 趋势               | `index/inventory/daily_summary.csv`；可视化看 `index/dashboard.html` |
| 当前状态、缺货多久 | `index/inventory/latest.jsonl`（since）+ `index/catalog/skus.jsonl`  |
| 产品级             | `index/views/products.jsonl`                                         |

## 输出

**日报**：一句话结论（有货率、较昨日、重点分类）→ 新到货/新缺货（按分类，同产品变体合并为一行）→ 需要行动：缺货 ≥14 天；有货率较 7 天前降 ≥10pt 的分类；近 30 天 EDM 推过但现在缺货的产品（`index/ledgers/edm_campaigns.jsonl`）。

**周报**：7 天到货/缺货/调价/上新/下架数；各分类有货率周初 vs 周末；反复波动（≥2 次变化）的 SKU；缺货最久前 10。

## 规则

数字全部来自文件；说明 SKU（变体）与产品口径；`unknown` 单列，不计入缺货。

## CLI 不可用时

本 skill 始终直接读取上面列出的 DATA_SPEC 文件即可；不执行写入、不重建数据，也不把 unknown 当作缺货。按日报最后一条 Job 记录检查新鲜度，并在结论中注明数据日期与 SKU/产品统计口径。
