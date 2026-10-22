# SiteIndex · 开发 agent 规则

你是 SiteIndex 三个并行开发 agent 之一。开始任何工作前：

1. 读 `docs/WORKSTREAMS.md`，确认你是 **A（Core）/ B（UI）/ C（Desktop）** 中的哪一个，以及你**只能修改的目录**
2. 读你的任务清单 `docs/tasks/A-core.md` / `B-ui.md` / `C-desktop.md`，按里程碑顺序做
3. 按任务清单"必读"列表阅读 `docs/` 中的相关章节；数据格式以 `docs/DATA_SPEC.md` 为准，界面以 `design/demo/` 画板为准

## 项目一句话
SiteIndex 是一个本地桌面软件（Windows 为主，兼容 macOS，下载安装包即可使用）。它把每个独立站变成云盘里的标准化项目文件夹（README + index/ 数据 + _agent/skills + 工作区文件夹），由软件负责确定性的数据工作（feed/sitemap 抓取、库存、SEO、校验、README、定时任务），由 Claude Code / Codex 等 agent 读取这些文件完成内容工作。

## 硬性规则
- 只改自己工作流的目录；`packages/shared/` 的修改走 WORKSTREAMS §4 契约流程（单独 `contract/*` 分支与 PR）
- 依赖方向：`ui → shared`；`cli → core → shared`；`desktop → core, shared`。ui 不得 import core/desktop；core 不得 import electron
- 禁止原生 Node 模块（better-sqlite3、sharp 等）；新增大型依赖需在 PR 中说明
- 路径常量一律用 `PATHS`；退出码用 `EXIT`；错误用 `SiteIndexError`
- core 输出必须与 `fixtures/expected/` 逐字节一致（排序用 `compareKeys`）
- **不要直接 push 到 `main`，不要合并自己的 PR**：提交 PR 后由审核者合并（WORKSTREAMS §3）
- 每个 PR：三系统 CI 全部通过（本地通过不算）；改了依赖就同时提交 `pnpm-lock.yaml`；勾选任务清单；标题前缀 `[A]`/`[B]`/`[C]`/`[contract]`
- 每个 PR 基于最新 `main` 开分支，不要叠在自己未合并的分支上
- 小步提交，PR ≤ 600 行改动为宜；开工前 `git pull --rebase origin main`
- 界面文案为中文；代码注释中文或英文均可

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
