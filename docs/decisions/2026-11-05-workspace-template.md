# 决策：SiteIndex 提供可选的 Agent 工作区模板（取代 2026-10-27 的"不管理工作区文件夹"）

> 2026-11-05 · 状态：已确认（用户） · 取代：`docs/decisions/2026-10-27-data-index-focus.md` 第 2 条与相关改动 · 影响：A / B / C / D / E

## 背景

10-27 的决策取消了软件创建工作区文件夹，原因是"由软件统一创建、逐个写 `_about.md`，与实际用法不符"。

实际使用一段时间后，用户在真实项目里形成了稳定的工作区结构（板块目录 + 数据层 + 审核流 + agent 规则），并且需要在每个新站点上重复建立。痛点变成：

1. 每个项目都要手工搭一遍目录，并重写 README / AGENTS.md。
2. 不同 agent（Codex、qwenpaw、workbuddy、千问办公、Claude Code）接入时，需要统一的入口说明。
3. EDM 等技能依赖固定的数据位置与板块目录，缺少统一约定就无法复用。

## 决策

1. SiteIndex 恢复"创建工作区"的能力，但改为**一次性、可选的模板生成**，不是持续管理：
   - 生成后，软件只维护 `_site-index/`（数据层）以及 `AGENTS.md` / `README.md` 里带 `siteindex:auto` 标记的区块；
   - 板块目录（`01-brand` … `07-reports`）、`_outputs/`、`_archive/`、`_tmp/` 生成后归用户和 agent 所有，软件不再读写、不校验、不删除；
   - 不再写 `_about.md`；每个板块只有一份一次性生成的 `README.md`，之后由用户和 agent 维护。
2. 数据目录在工作区布局中为 `_site-index/`，**直接放在其下**（`_site-index/catalog/…`，不再套 `index/`）。旧项目继续使用 `index/`，两种布局并存，由 `site.json` 所在位置判定（见 v0.4 路线图 §3）。
3. 创建工作区要求**目标目录为空**（忽略 `.git`、`.DS_Store`、`Thumbs.db`、`desktop.ini`）；不空则直接拒绝并提示，不提供合并、覆盖或预览。创建项目和"创建空工作区"两种入口规则相同。
4. `README.md` 与 `AGENTS.md` 重新分工：README 负责"项目是什么、目录在哪"，AGENTS.md 负责"agent 怎么干活"。`CLAUDE.md` 只写 `@AGENTS.md`。
5. 业务规则以**可选预设**提供，写法保持通用（受众 ID、连接标识等一律由技能运行时向用户询问并记录，不进模板）。当前只有 Mailchimp 预设，以后新增其他渠道（如 Klaviyo）随程序更新增加。
6. 目录编号变化不应破坏技能：工作区生成 `_site-index/workspace.json`，把"逻辑名"映射到真实路径，技能只读这份映射。
7. 2026-10-27 决策中"Skill 中心保留，定位是告诉 agent 如何使用数据"继续有效；新增的 EDM 技能会涉及板块目录，但通过 `workspace.json` 间接引用。

## 不变的部分

- 老项目（`index/` 布局）行为不变；已有 `_about.md` 原样保留。
- 软件不创建、不管理 `01-brand` … `07-reports` 内的任何后续内容。
- 软件不删除用户文件。

## 影响

见 `docs/plan/2026-11-05-v040-roadmap.md`。
