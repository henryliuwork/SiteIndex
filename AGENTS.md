# SiteIndex · 开发 agent 规则

你是 SiteIndex 的并行工作流之一（A / B / C / D / E）。开始任何工作前：

1. 读 `docs/WORKSTREAMS.md` §1，确认你是 **A（Core）/ B（UI 共享层）/ C（Desktop）/ D（UI 项目页面）/ E（真实项目验收）** 中的哪一个，以及你**只能修改的目录**
2. A/B/C 读各自任务清单 `docs/tasks/A-core.md` / `B-ui.md` / `C-desktop.md`；D/E 按当前收敛计划认领任务。v0.6.0 规范见 `docs/plan/2026-11-16-v060-ui-spec-roadmap.md`，v0.6.1–v0.6.5（UI 细节收口 + WooCommerce 全面支持）以 `docs/plan/2026-11-17-v061-v065-roadmap.md` 为准；**当前执行计划 v0.8.0（页面外框、导航与表格规范统一）以 `docs/plan/2026-11-20-v080-ui-frame-spec-roadmap.md` 为准；v0.7.0 / v0.7.5 见 `docs/plan/2026-11-18-v070-v075-roadmap.md`，目标模式运行手册（lead、汇报、缺陷流程）见 `docs/plan/2026-11-18-v07-lead-playbook.md`**；v0.3 表格标准仍以 `docs/plan/2026-11-05-v030-roadmap.md` 为参考；历史计划 `docs/plan/2026-10-30-v020-wave2-execution.md`、总计划 `docs/plan/2026-10-29-v020-convergence.md`、`docs/plan/2026-10-29-feedback-v2.md` 保留为需求背景
3. 按任务清单"必读"列表阅读 `docs/` 中的相关章节；数据格式以 `docs/DATA_SPEC.md` 为准，界面以 `design/demo/` 画板为准

## 项目一句话
SiteIndex 是一个本地桌面软件（Windows 为主，兼容 macOS，下载安装包即可使用）。每台设备使用本机非同步目录中的独立标准化项目文件夹（README + index/ 数据 + _agent/skills；其他目录归用户自己管理，见 docs/decisions/2026-10-27-data-index-focus.md）；软件不支持通过云盘同步同一份项目。由软件负责确定性的数据工作（feed/sitemap 抓取、库存、SEO、校验、README、定时任务），由 Claude Code / Codex 等 agent 读取这些文件完成内容工作。

## 硬性规则
- 只改自己工作流的目录；`packages/shared/` 的修改走 WORKSTREAMS §4 契约流程（单独 `contract/*` 分支与 PR）
- UI 页面归属：**B** 负责共享组件/全局样式、`ReadmePage`、`AppSettingsPage`，以及应用级 `ProjectCenterPage`、`NewProjectWizardPage`、`SkillsPage`；**D** 负责 `OverviewPage`、`ProductsPage`、`EdmPage`、`DesignPage` 等项目业务页及现有 D 页面。对应局部样式与 mock 命名空间随页面归属；详见 WORKSTREAMS §1/§5.1。
- 依赖方向：`ui → shared`；`cli → core → shared`；`desktop → core, shared`。ui 不得 import core/desktop；core 不得 import electron
- 禁止原生 Node 模块（better-sqlite3、sharp 等）；新增大型依赖需在 PR 中说明
- 路径常量一律用 `PATHS`；退出码用 `EXIT`；错误用 `SiteIndexError`
- core 输出必须与 `fixtures/expected/` 逐字节一致（排序用 `compareKeys`）
- **不要直接 push 到 `main`，不要合并自己的 PR**：提交 PR 后由审核者合并（WORKSTREAMS §3）
- 每个 PR：三系统 CI 全部通过（本地通过不算）；改了依赖就同时提交 `pnpm-lock.yaml`；勾选任务清单；标题前缀 `[A]`/`[B]`/`[C]`/`[D]`/`[contract]`/`[docs]`
- 每个 PR 基于最新 `main` 开分支，不要叠在自己未合并的分支上
- 小步提交，PR ≤ 600 行改动为宜；开工前 `git pull --rebase origin main`
- **仓库公开**：禁止提交密钥、token、Webhook、真实客户或订单数据
- 界面文案为中文；代码注释中文或英文均可
- **缺陷修复范围（v0.7.x 起）**：只修三类——本版本新引入的回归、数据错误或丢失、阻断安装与启动；且须先由 lead 归类并打 `v07-fix`。其余一律进 backlog，不得顺手修复；每个缺陷最多修 2 轮，修复 PR ≤ 200 行。详见 v0.7 手册 §5

## UI/UX 硬性规则
- 字体只用 `tokens.css` 中的 `--font-sans` / `--font-mono`，页面不得自行写 `font-family`。字体栈为 Geist（英文数字）→ Microsoft YaHei UI / PingFang SC（中文，系统字体）→ 随包 Source Han Sans SC（兜底，必须随 UI 打包，不依赖联网）。界面字重只用 400 与 600，不使用 500。
- 正文字号使用字号 token；正文为 12px，任何文字不得小于 10px。页面不得新增裸字号、裸色值或裸 px 间距；新样式先使用或扩展语义 token。
- 控件统一使用 `--control-height`（32px）或 `--control-height-compact`（28px）。输入框与同行按钮组合使用共享 `InputWithAction`，页面不得自行拼 flex 组合。
- Tab 只有项目导航 Tab（路由切换）和页内分段 Tab（内容切换）两种；不得新增第三层 Tab。窄窗口下项目导航 Tab 与页头操作按钮均收纳到“更多 ⋯”，禁止出现横向滚动条。
- **界面精简与提示原则**：`Avoid unnecessary secondary labels and descriptions. Let the layout do the explaining.` 尽量通过布局和标签本身让用户直观理解，不写冗余副标题或大段操作说明；确需解释时使用共享 `<InfoTooltip>`（圆形 `i` 图标 hover/focus 展示短句）。
- **表格顶部操作区规范**：采用固定两层结构——页内视角切换 `Segmented` 前置，工具栏固定“左：搜索 + 筛选（超过两行可折叠） / 右：视图开关 + 列设置 + 统计计数”；运行、同步、导出、规则设置等整页级动作统一放右上角页头，不混入表格筛选条；批量操作仅在勾选行后浮出。
- 日期时间通过共享 `formatDateTime` 展示，跨年时带年份；禁止“今天 / 昨天”等相对前缀，并避免在同页重复显示同一时间信息。
- **页面外框（v0.8.0）**：页面只有两种外框，由共享 `PageFrame` 提供，页面不得自设顶部距离、`calc(100vh - …)` 或负 margin。**全局页**（项目中心、Skill 中心、定时任务、设置、新建向导）：标题行高 56px，上内边距 24px，不吸顶。**项目页**：项目头紧贴标题栏、上内边距 0、吸顶，单行高 48px（左导航 Tab、右页头操作），内容起点距项目头 16px；项目名、平台、最近运行时间只在侧栏项目项（两行：`项目名` / `平台 | MM-DD HH:mm`），页头不再显示域名与状态 chip。
- **滚动**：含表格的页面窗口与内容区都不滚动，只有表格体内部滚动；无表格的页面只有项目头下方内容区滚动；一个页面只允许一个纵向滚动容器。
- **页头按钮**：高 32px、左右内边距 12px、按钮间距 12px、图标 16px；每页 ≤1 主 + ≤2 次 + “更多 ⋯”。
- **表格上方节奏**：SummaryLine / 已选筛选标签行 / 工具栏 / 表格四个区域之间统一 `--space-section-gap`（12px）；搜索框与筛选按钮高 32px、间距 8px，不得靠页面私有 margin 调整。
- **表格列**：选择框 → 标识列 → 名称列 → 状态 → 度量 → 时间 → 右侧固定操作列；有 SKU 的表格 **SKU 单独成列居首并左侧固定**（等宽字体）；数字右对齐并用等宽数字。InfoTooltip 内长串必须折行，不得溢出气泡。完整规范与 `ui:check` 断言见 v0.8.0 roadmap §3。
- **小样式问题**：只处理 v0.8.0 冻结审计清单内的可测量违例；清单冻结后新发现的一律进 backlog，不得追加。
- 涉及 UI 的 PR 必须附 `pnpm ui:check` 输出；样式扫描中新违规会使检查失败，日期/时间重复启发式只给人工复核告警。
- **板块页（SEO、内容、EDM、产品管理、概览）**：按 `docs/DESIGN.md` §3 的固定骨架组织；项目头之后最多一行可操作 `SummaryLine`，同一数字与时间不得重复，表格为首屏主体。SEO 的问题/页面/内链属于同一实体，应合并进页面表与行抽屉；其他页内分段仅用于不同实体，且无计数徽标。v0.7.5 迁移前先交合并矩阵，`ui:check` §3.5 指标必须达标。

## 常用命令
```bash
pnpm install
pnpm typecheck          # 全部包
pnpm test               # vitest
pnpm dev:ui             # 浏览器中运行界面（mock 数据）
pnpm dev:desktop        # Electron 开发模式
```

## 目录速览
| 路径 | 内容 |
|---|---|
| `docs/PRD.md` | 产品需求（MVP v1.1） |
| `docs/ARCHITECTURE.md` | 技术架构、命令行、计划任务、打包 |
| `docs/DATA_SPEC.md` | 项目文件夹与全部数据表规范、校验规则 |
| `docs/DESIGN.md` | 设计 token、组件、画板→路由 |
| `docs/WORKSTREAMS.md` | 分工、分支、契约流程、里程碑 |
| `design/demo/` | 21 个界面画板源码 |
| `packages/shared/` | 类型契约（`api.ts` = 界面可调用的全部接口） |
| `reference/` | Python 参考实现（行为基准） |
| `fixtures/` | 测试输入与黄金输出 |
| `schemas/` | JSON Schema |
| `skills/`、`templates/` | 分发给项目与 agent 的 skill 和项目模板 |
