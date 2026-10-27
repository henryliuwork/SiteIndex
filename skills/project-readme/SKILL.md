---
name: project-readme
version: 1.1.0
description: 仅在用户明确要求时补充 README 的项目概况、当前重点或工作规则与偏好等用户区块。
reads:
  - README.md 用户维护区块
writes: []
---

# project-readme

本 skill 只处理 README 用户维护区块：项目概况、当前重点、工作规则与偏好。不得管理项目工作目录，不创建或修改 _about.md。

## 读哪些数据

只读取 README 中需要编辑的用户区块及其相邻上下文。不要读取工作目录或遍历项目文件；不要改动 index/、_agent/、AGENTS.md、CLAUDE.md，也不要改 README 自动生成区块。

## 如何筛选判断

只有用户明确提出修改 README 用户区块时才执行。保留未要求修改的文字；不确定事实时询问用户，不推断业务数据。写入前展示修改前后差异并等待用户确认。

## 写哪些台账

无。用户确认后只改 README.md 中指定的用户区块；所有 siteindex:auto 标记范围内的内容保持原样。
