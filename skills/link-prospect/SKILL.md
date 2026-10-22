---
name: link-prospect
version: 1.0.0
description: 按用户给定方向搜集可合作的外链网站与联系方式，去重后通过 MCP 录入 linkflow，并更新项目外链去重台账。用户要求找外链、合作网站、博主、媒体时使用。
---

# link-prospect

工作目录为项目根目录。真相源是 linkflow；`index/ledgers/outreach.jsonl` 只用于去重。

## 准备
读 `index/site.json`：domain、brand、markets、seo.core_keywords、seo.competitors、integrations.linkflow；读 outreach.jsonl 已有域名。未提供时确认：方向、数量（默认 20）、类型、市场/语言。

## 搜集
每个候选：domain（小写去 www）、site_name、url、type（blog/media/resource/directory/forum/podcast）、relevance（一句话）、contact（页面上实际存在的邮箱/联系页/社媒）、evidence_url（write for us、resources 等）、last_active。

排除：已在台账；竞品与本站；12 个月无更新；PBN/链接农场；无任何联系方式。不得编造联系方式。

## 录入
用 `integrations.linkflow.mcp_server` 的 `create_tool` 录入；未配置时输出 `.tmp/prospects.csv` 交给用户。单条失败记录原因继续。

成功录入的域名：
```bash
siteindex ledger upsert . outreach --rows .tmp/outreach.jsonl
```
每行：`{"domain","status":"pushed","linkflow_id","topic","note"}`

## 交付
录入数、类型分布、无联系方式清单、排除原因统计、失败条目。
