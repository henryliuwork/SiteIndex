---
name: project-readme
version: 1.0.0
description: 补充和整理当前网站项目的说明：为工作区文件夹编写 _about.md，协助用户完善 README 的用户区块（项目概况、当前重点、工作规则）。用户说"整理一下项目说明""补全文件夹说明"或 README 目录地图出现"待补充说明"时使用。
reads:
  - README.md
  - 工作区目录与文件
writes:
  - README.md 用户区块
  - 工作区文件夹/_about.md
---

# project-readme

工作目录为项目根目录。

## 不可修改

- README 中 `<!-- siteindex:auto:start … -->` 与 `<!-- siteindex:auto:end … -->` 之间的内容（由 SiteIndex 生成）
- `index/`、`_agent/` 下的任何文件

## 补充 _about.md

对 README「目录地图」中标注"待补充说明"的文件夹：

1. 浏览该文件夹的文件名、子目录与少量文件内容（每个文件只读开头）
2. 写 `_about.md`：第一段一句话用途（≤40 字）；之后列出子目录约定、命名规律、哪些是最终版（只写观察到的事实）
3. 无法判断用途时，写出观察结果并询问用户，不要猜测

## 完善用户区块

仅在用户要求时修改「项目概况」「当前重点」「工作规则与偏好」：

- 先展示修改前后对比，用户确认后写入
- 不删除用户已写的内容，只补充或按用户要求改写

## 交付

新建/修改的 `_about.md` 清单；提示用户在 SiteIndex 中点"刷新 README"或等待每周自动刷新。

## CLI 不可用时

直接按本文件规则读取 README 和工作区目录，再用文件操作创建 `_about.md`。只有用户明确要求完善用户区块时，才先展示修改前后对比并等待确认后写 README；保留所有未要求修改的文字，也不要更改 README 的 siteindex:auto 区块、index/ 或 _agent/。
