# SiteIndex · 并行开发分工（3 个 agent）

> 所有开发 agent 开工前必读：本文件 → `AGENTS.md` → 自己的任务清单 `docs/tasks/{A,B,C}-*.md` → PRD / ARCHITECTURE / DATA_SPEC / DESIGN 中相关章节。

## 1. 三个工作流

| 工作流 | 负责目录（只改这些） | 一句话 |
|---|---|---|
| **A · Core** | `packages/core/`、`packages/cli/`、`schemas/`、`fixtures/`、`reference/` | 所有数据逻辑：抓取、库存、视图、SEO、校验、README、台账、分类、Job；以及命令行 |
| **B · UI** | `packages/ui/` | 全部 21 个画板对应的 React 界面；浏览器里用 mock 独立开发 |
| **C · Desktop** | `packages/desktop/`、`.github/workflows/`、`skills/`、`templates/` | Electron 外壳、IPC 接线、系统计划任务、执行设备/锁、文件夹/回收站、skill 分发、浏览器检测、打包发布 |
| 共有 · 契约 | `packages/shared/` | 类型与接口。改动走第 4 节流程 |

`docs/` 下：各工作流只改自己的任务清单（勾选进度、补充说明）。PRD / ARCHITECTURE / DATA_SPEC / DESIGN 的修改按契约流程处理。根目录配置（`package.json`、`pnpm-workspace.yaml`、`tsconfig.base.json`、`vitest.config.ts`）归 C；其他工作流需要改时在 PR 里说明。

依赖方向（违反即打回）：`ui → shared`；`cli → core → shared`；`desktop → core, shared`（ui 以构建产物加载）。**ui 不得 import core 或 desktop；core 不得 import electron。**

## 2. 接口如何分给 A 和 C

`packages/shared/src/api.ts` 的 `SiteIndexApi` 是界面能调用的全部接口。实现分两层：

- **A 在 core 里实现 `createCoreService(ctx)`**，返回一个对象，覆盖下表中"core"列的方法，签名与 `SiteIndexApi` 完全一致；`ProjectId → 项目路径` 的换算由 C 通过 `ctx.resolveProject(id)` 注入（见 A 任务 A8）。纯 Node，可在命令行与测试中直接调用。
- **C 在 desktop 里实现剩下的方法**（需要 Electron / 操作系统的部分），并把 core 部分接到 IPC 上。

| 命名空间 | core（A） | desktop（C） |
|---|---|---|
| app | — | 全部 |
| settings | — | 全部（含浏览器检测、命令行安装、选目录） |
| projects | detect、inspectFeed、create（写文件夹）、读取项目摘要/详情、updateConfig | list（扫描 projects_root + extra_projects）、addExisting、onChanged（chokidar） |
| overview / inventory / products / seo / content / edm / design / readme / categories | 全部查询与写台账 | exportCsv 的保存对话框；seo.checkIndex 的浏览器调度（调用 core 的 index-check Job） |
| folders | list、create、describe（写 `_about.md`、site.json、README 区块） | remove（`shell.trashItem`）、open |
| files | validate、repair、lastReport | — |
| jobs | 每个 Job 的实现 `runJob(req, report)` | run（utilityProcess）、cancel、running、history 读取、事件转发 |
| schedule | 读写 `site.json.schedule` | 注册/删除系统计划任务、next_runs |
| runner | 读写 `.runner.json`、锁 | claim 时提供本机 device_id |
| skills | — | 全部 |
| shell | — | 全部 |

## 3. 分支与 PR

- **`main` 只通过 PR 更新**。仓库是私有免费版，GitHub 不强制分支保护，以下规则靠自觉执行：
  - 禁止直接 push 到 `main`；禁止合并自己的 PR
  - PR 合并前 CI 必须通过；**本地通过不算**。为节省私有仓库的 Actions 分钟：PR 只跑 Linux；合并到 main 后加跑 Windows；macOS 只在打 tag 发布时打包（手动运行 Release 默认只打 Windows）
  - 改动 Windows 相关逻辑（路径、计划任务、安装包）的 PR，作者需在 PR 描述里写明本机 Windows 上的验证结果
  - 由审核者（项目协调 agent）检查 CI、改动目录、契约后合并；用 **merge commit**（不用 squash）
  - 新增或升级依赖时，必须在同一个 PR 里提交更新后的根目录 `pnpm-lock.yaml`（CI 使用 `--frozen-lockfile`）
- 分支命名：`a/<主题>`、`b/<主题>`、`c/<主题>`、契约 `contract/<主题>`。
- PR 小而频繁（建议 ≤ 600 行改动）。**每个 PR 都基于最新 `main` 开分支**，不要叠在自己未合并的分支上；前一个 PR 未合并时可以先开下一个，但依赖前一个的改动要等它合并后再 rebase。标题前缀 `[A]`/`[B]`/`[C]`/`[contract]`。
- 每个 PR 勾选对应任务清单条目；开工前先 `git pull --rebase origin main`。
- 不要修改其他工作流目录下的文件；发现对方的 bug，开 issue 并 @ 对应工作流（标签 `ws:A`/`ws:B`/`ws:C`）。

## 4. 契约变更流程（`packages/shared/`）

1. 单独开 `contract/<主题>` 分支，PR 只包含 `packages/shared/` 的改动（必要时附带 docs 中对应说明）。
2. 只做**加法**优先：新增字段用可选（`?`），新增方法不改旧方法。破坏性改动必须在 PR 描述里写明影响的工作流与迁移方式。
3. 合并后，其他两个工作流在下一个 PR 前 rebase；B 同步更新 mock，C 同步更新 IPC 路由。
4. 同一时间最多一个未合并的契约 PR，避免冲突。

## 5. 里程碑与集成检查点

| 里程碑 | A · Core | B · UI | C · Desktop | 集成验收 |
|---|---|---|---|---|
| **M1 骨架跑通**（第 1 周） | 文件读写基础（原子写、JSONL/CSV、锁）、feed 解析、daily 合并 —— 黄金测试 day1–4 通过 | 应用框架、路由、设计 token、通用组件（表格/药丸/详情面板/列设置/分页）、mock 层、项目中心、库存页 | Electron 窗口（圆角、标题栏）、preload/IPC 骨架、加载 ui、Windows 安装包在 CI 产出 | Windows 上安装包能打开，界面显示 mock 数据的项目中心与库存页 |
| **M2 功能完整**（第 2–3 周） | weekly（SEO 页面/问题/内链/博客/产品详情/分类）、views、validate+repair、readme、台账、categories、folders、命令行全部命令、`createCoreService` | 全部 21 个画板页面与交互；mock 覆盖全部接口 | IPC 接 core；Job 在 utilityProcess 执行与进度；计划任务（Windows/mac）；执行设备与锁；文件夹/回收站；skill 分发；设置；`--run-job` 无界面模式；命令行安装 | 真实项目：新建向导 → daily → 各页面真实数据；计划任务能触发 |
| **M3 MVP 验收**（第 4 周） | design、index-check（playwright-core + 系统浏览器）、性能（1 万 SKU < 30 秒） | 细节对照画板、空状态/错误状态/加载态、大数据分页性能 | mac dmg、通知、打 tag 发布 Release、README 安装说明 | PRD §8 的 8 个端到端场景在干净的 Windows 11 上全部通过 |

每个里程碑结束时由 C 负责合并后跑一次完整构建，在 issue `Milestone Mx 集成` 里记录结果与遗留问题。

## 6. 共用约定

- TypeScript strict；不使用 `any`（确需时 `unknown` + 收窄）。
- 测试：vitest。core 每个模块有单测；黄金测试对比 `fixtures/expected/`。ui 组件逻辑（筛选、分页、长度标色）有单测。desktop 的计划任务 XML/plist 生成有快照测试。
- 路径：业务代码一律用 `PATHS`（shared/paths.ts），禁止手写 `"index/..."` 字符串。Windows 路径在 desktop 层用 `path.win32` 处理，core 内部统一 POSIX 相对路径 + `path.join`。
- 文本：UTF-8 无 BOM、LF；中文界面文案。
- 日志：core 只通过 `ProgressReporter` 输出，不直接 `console.log`。
- 不引入新的大型依赖前先在 PR 描述里说明理由（体积、原生模块会影响打包）。**禁止原生模块**（better-sqlite3 等），缓存用 sql.js 或纯 JSON。
