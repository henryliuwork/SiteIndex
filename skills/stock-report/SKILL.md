---
name: stock-report
version: 1.1.0
description: 根据库存、变化事件与运行记录回答库存问题并生成日报、周报或趋势分析；只读。
reads:
  - index/logs/runs.jsonl
  - index/logs/validation.json
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

先遵循 siteindex-data 的数据格式与不编造规则。本 skill 只读取数据并在回复中交付分析，不写文件或台账。

## 读哪些数据

- 某日情况：index/reports/daily/YYYY-MM-DD.md。
- 时间段变化：index/inventory/events/YYYY-MM.jsonl，按 date 过滤。
- 分类库存趋势：index/inventory/daily_summary.csv。
- 当前 SKU 状态和持续天数：index/inventory/latest.jsonl 与 index/catalog/skus.jsonl。
- 产品级库存与标签：index/views/products.jsonl。
- 推品后当前库存：index/ledgers/edm_campaigns.jsonl 与当前产品视图。
- 数据新鲜度：index/logs/runs.jsonl；校验异常：index/logs/validation.json。

## 如何筛选判断

- 先读最近 daily run。若不是今天或 status=failed，说明日期和 errors，使用最近成功数据；partial 必须标注可能不完整。
- 日报总结有货率、变化、重点分类，再列到货/缺货，并按当前有货率下降或长期缺货情况提出行动项。
- 周报统计 7 天内库存、价格、新品和下架事件；比较各分类周初与周末有货率；列出反复波动 SKU 与缺货时间最长的项目。
- 明确区分 SKU（变体）和产品口径；unknown 单独列出，不计作缺货。阈值判断只用数据中可核实的日期与数值。

## 写哪些台账

无。本 skill 只在对话中返回库存分析；如用户要求保存报告，先询问保存位置，并按用户指定的位置保存，不创建固定报告目录。
