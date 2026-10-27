# 决策：SiteIndex 聚焦数据索引，不再管理工作区文件夹

> 2026-10-27 · 状态：已确认（用户） · 影响：A / B / C 三个工作流

## 背景
v1.1 把 `seo/ edm/ 产品/ 内容/ 设计/ 报告/` 作为“工作区文件夹”由软件创建，每个文件夹写 `_about.md`，README 有 `folder-map` 自动区块，设置里有“文件夹”页，概览里有“缺文件夹说明”提醒。

这些文件夹原本只是用户自己在项目下建的归档目录，用来放日常工作成果。由软件统一创建、要求写说明，与实际用法不符，也偏离了软件的核心。

## 决策
1. **SiteIndex 的核心是网站数据索引**：抓取并维护 `index/`（feed、库存、SEO、博客、分类、设计规范、台账、视图），提供查询、校验与定时同步。
2. **工作文件夹归用户自己管**：软件不再创建默认工作区文件夹、不再写 `_about.md`、不再维护 `workspace_folders`、不再生成 `folder-map` 区块、不再有“设置 › 文件夹”页。用户在项目根目录下怎么建目录、怎么归档，软件不干预、不校验、不删除。
3. **Skill 中心保留，定位改为“告诉 agent 如何使用数据”**：每个 skill 说明该场景要读哪些数据、字段含义、怎么查询（`siteindex query` 或直接读文件）、怎么写台账、哪些数据不能编造。skill 不再规定成果写入哪个工作区文件夹；成果放在哪里由用户在 README「工作规则与偏好」里说明，或由用户当次指定。
4. **已有项目兼容**：已创建的文件夹和 `_about.md` 原样保留，软件只是不再读写它们；`site.json` 中残留的 `workspace_folders` 字段读取时忽略、写回时去掉。

## 各工作流改动
| 工作流 | 改动 |
|---|---|
| contract（本 PR） | 更新 PRD / DATA_SPEC / ARCHITECTURE / README / AGENTS；`api.ts` 的 `folders` 命名空间与 `CreateProjectInput.folders` 标记 `@deprecated`（不删除，待 A/B/C 完成后再移除） |
| A · Core | `projects.create` 不再建工作区文件夹与 `_about.md`；readme 去掉 `folder-map` 区块（已有标记保留但不再填充，`readme_markers` 校验不报错）；overview 去掉“缺文件夹说明”；site.json schema 把 `workspace_folders` 改为可选并在写回时去掉；CLI 去掉 `folders` 命令 |
| B · UI | 去掉“设置 › 文件夹”页与路由；新建向导第 3 步去掉“默认工作区文件夹”勾选；README 页去掉目录地图预览与“管理文件夹与说明”；概览去掉相关提醒与快捷操作中的“打开工作区”（保留“打开项目文件夹”） |
| C · Desktop | 去掉 `folders.*` IPC；模板去掉 `templates/project/_about.md`、README 模板去掉 `folder-map`；skills 按第 3 条改写（见下） |

## Skill 改写方向
- 新增 `siteindex-data`（基础 skill，其他 skill 引用它）：数据目录、各表主键与关键字段、`siteindex query/ledger` 用法、直接读写文件时的格式规则、不得编造的字段
- 场景 skill（edm-builder、blog-writer、stock-report、sku-media-enrich、link-prospect、page-design）：保留，但 `writes` 只列台账；正文改为“读哪些数据 → 如何筛选/判断 → 写哪些台账”，去掉固定输出目录
- `project-readme`：只负责 README 用户区块，去掉 `_about.md` 相关内容
