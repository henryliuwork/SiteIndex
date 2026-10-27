---
name: link-prospect
version: 1.1.0
description: 按用户给定方向寻找潜在外链合作网站，核实证据并通过 LinkFlow 去重录入。
reads:
  - index/site.json
  - index/ledgers/outreach.jsonl
writes:
  - index/ledgers/outreach.jsonl
---

# link-prospect

先遵循 siteindex-data 的数据格式与不编造规则。

## 读哪些数据

读取 index/site.json 的 domain、brand、markets、seo.core_keywords、seo.competitors、integrations.linkflow；读取 index/ledgers/outreach.jsonl 中已有 domain 以去重。方向、数量、网站类型和目标市场未提供时先询问用户。

## 如何筛选判断

- 为每个候选核实 domain、名称、网站类型、相关性、实际存在的联系方式、证据 URL 和最近活动迹象。
- 排除本站、竞品、已在 outreach 台账的域名、明显链接农场，以及无法找到相关证据的站点。
- 联系方式只能来自页面实际内容；没有公开联系方式时标记缺失，不推断邮箱或个人资料。
- LinkFlow 连接不可用时在对话中交付候选和证据，不声称已录入。候选或临时结果的位置由用户指定，不创建固定文件。

## 写哪些台账

仅将已成功录入 LinkFlow 的域名合并写入 index/ledgers/outreach.jsonl，主键为小写 domain；记录真实 added_at、status、linkflow_id、topic、note、target_url 与 live_link。按 DATA_SPEC §5.15 排序并保留字段顺序。逐项说明录入成功、失败及原因。
