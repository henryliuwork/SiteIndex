# SiteIndex · 技术架构（v1.1）

> 配合 PRD.md、DATA_SPEC.md、WORKSTREAMS.md 阅读。

## 1. 技术栈

| 层 | 选型 |
|---|---|
| 桌面 | Electron（当前稳定版）+ electron-vite；electron-builder 打包 |
| 界面 | React 19 + TypeScript + Tailwind CSS v4 + Radix UI 原语（或 shadcn/ui）；表格 TanStack Table + TanStack Virtual；图表 Recharts |
| 核心 | 纯 Node TypeScript（`@siteindex/core`），不依赖 Electron |
| 解析 | fast-xml-parser（feed、sitemap）、htmlparser2（页面）、csv-parse/csv-stringify 或自写（需保证字节级格式） |
| 校验 | ajv（加载 `schemas/*.schema.json`） |
| 本机库 | sql.js（WASM，查询缓存，可选） |
| 浏览器自动化 | playwright-core，`channel: "msedge"` → `"chrome"` → 设置中的路径；不打包浏览器 |
| 测试 | Vitest；UI 用 Testing Library；E2E 用 Playwright（Electron 模式） |
| 包管理 | pnpm workspaces；Node ≥ 20 |

## 2. 仓库结构

```
SiteIndex/
├── AGENTS.md / CLAUDE.md        开发 agent 规则（入口）
├── docs/                        PRD · ARCHITECTURE · DATA_SPEC · DESIGN · WORKSTREAMS · tasks/
├── design/demo/                 21 个画板源码（界面参考）
├── schemas/                     JSON Schema（数据契约）
├── packages/
│   ├── shared/   @siteindex/shared  类型、路径常量、IPC/CLI 契约、错误码（三方共用，改动需走契约流程）
│   ├── core/     @siteindex/core    全部业务逻辑与 Job（工作流 A）
│   ├── cli/      @siteindex/cli     命令行（工作流 A）
│   ├── ui/       @siteindex/ui      React 界面，可在浏览器用 mock 独立运行（工作流 B）
│   └── desktop/  @siteindex/desktop Electron main/preload、系统集成、打包（工作流 C）
├── skills/  templates/              分发给项目与 agent 的内容
├── reference/  fixtures/            Python 参考实现与黄金测试数据
└── .github/                         CI、PR 模板
```

依赖方向：`ui → shared`；`desktop → core, shared, ui(构建产物)`；`cli → core, shared`；`core → shared`。**ui 不得依赖 core / desktop。**

## 3. 进程模型

```
┌─────────────── Electron main（desktop） ───────────────┐
│ 窗口 · IPC 路由 · 设置 · 通知 · 计划任务注册 · 文件夹操作 │
│      │ utilityProcess（每个 Job 一个）                  │
│      ▼                                                  │
│  JobHost → @siteindex/core.jobs.*  ──► 项目文件夹（云盘）│
│      │ 进度事件                       ──► 本机缓存        │
└──────┼──────────────────────────────────────────────────┘
       ▼ IPC（contextBridge 暴露 window.siteindex，类型 = shared/api.ts）
   Renderer（ui）
```
- 读数据（列表、详情）在 main 进程直接调用 core 的查询函数（带分页/筛选），结果缓存在内存，文件变化（chokidar 监听 index/）时失效
- Job 在 utilityProcess 执行，界面不阻塞；同一项目同时只允许一个 Job（运行锁）

## 4. 三种启动方式（同一个程序）

| 方式 | 触发 | 行为 |
|---|---|---|
| 界面 | 双击 | 单实例；显示窗口 |
| 定时 | `SiteIndex.exe --run-job "<projectPath>" <job>` | 无窗口执行、通知、退出；不受单实例锁限制 |
| 命令行 | `siteindex …`（PATH 中的启动脚本，`ELECTRON_RUN_AS_NODE=1` 运行内置 `cli.js`） | 等同 Node 程序 |

Windows 启动脚本 `%LOCALAPPDATA%\SiteIndex\bin\siteindex.cmd`：
```bat
@echo off
set ELECTRON_RUN_AS_NODE=1
"%LOCALAPPDATA%\Programs\SiteIndex\SiteIndex.exe" "%LOCALAPPDATA%\Programs\SiteIndex\resources\cli.js" %*
```
macOS：`~/.local/bin/siteindex` → `/Applications/SiteIndex.app/Contents/MacOS/SiteIndex`。

## 5. 窗口

- Windows：`frame` 保留，`titleBarStyle: "hidden"` + `titleBarOverlay`（颜色与标题栏一致，高 38）→ 原生最小化/最大化/关闭 + Windows 11 原生圆角；标题栏区域 `-webkit-app-region: drag`
- macOS：`titleBarStyle: "hiddenInset"`，左侧留出红绿灯位置
- 最小窗口 1100×720；记住窗口位置与大小

## 6. 命令行（`siteindex`）

`<p>` 可为项目路径或项目名。全部支持 `--json`。

| 命令 | 作用 |
|---|---|
| `detect <url>` | 跳转、robots、sitemap、平台、语言 |
| `init <dir> --url --feed [--name] [--folders …]` | 新建项目 |
| `feed inspect <p>` | feed 字段覆盖率、分类、示例 |
| `run <p> <daily\|weekly\|monthly\|validate\|readme\|design\|index-check> [--date] [--force] [--only <step>]` | 执行 Job |
| `validate <p> [--repair] [--file <path>]` | 校验；`--repair` 执行修复映射 |
| `views <p>` | 重建视图 |
| `query <p> <products\|sku-stock\|seo-pages\|seo-issues\|blog\|keywords\|sku-media> [filters] [--page --size]` | 查询（agent 选品用） |
| `ledger upsert <p> <keywords\|sku_media\|sku_tags\|edm_campaigns\|outreach> --rows <file\|->` | 台账写入 |
| `ledger delete <p> <ledger> <key…>` | 台账删除 |
| `edm render <p> <campaignDir> [--allow-oos]` | 渲染 EDM |
| `categories preview <p>` / `categories apply <p>` | 分类匹配预览 / 重新归类 |
| `folders list\|create\|describe\|delete <p> …` | 工作区文件夹 |
| `schedule install\|remove\|list <p>` | 系统计划任务 |
| `runner show\|claim <p>` | 执行设备 |
| `skills list\|sync <p>\|install <name> --platform <id>` | skill |

退出码见 `packages/shared/src/errors.ts`：0 成功；1 校验失败；2 数据源失败；3 保护阈值中止；4 锁被占用；5 非执行设备（定时模式静默）；6 参数错误；7 浏览器不可用。

## 7. 文件写入
原子写：同目录 `.{name}.tmp-{pid}` → fsync → rename；Windows `EPERM/EBUSY` 重试 10 次（200ms 递增）。JSONL/CSV/JSON 序列化必须与参考实现逐字节一致（排序用 `<` 比较字符串）。

## 8. 执行设备与运行锁
- `.runner.json`：定时模式下非执行设备直接退出码 5，不写任何文件
- `.lock`：`wx` 独占创建，30 秒心跳，10 分钟无心跳视为僵尸锁
- 云盘同步有延迟，执行设备是主要防线，锁是第二道

## 9. 定时任务

### 9.1 Windows（任务计划程序）
`schtasks /Create /TN "\SiteIndex\{projectId}-{job}" /XML <utf16le.xml> /F`；按 `schedule` 生成触发器：
- 每天 / 部分周几：`<CalendarTrigger><ScheduleByWeek><DaysOfWeek><Monday/>…</DaysOfWeek><WeeksInterval>1</WeeksInterval></ScheduleByWeek></CalendarTrigger>`
- 每月：`<ScheduleByMonth><DaysOfMonth><Day>1</Day></DaysOfMonth><Months>全部</Months></ScheduleByMonth>`
- Settings：`StartWhenAvailable`（错过补跑）、`WakeToRun`（唤醒）、`DisallowStartIfOnBatteries=false`、`MultipleInstancesPolicy=IgnoreNew`、`ExecutionTimeLimit=PT2H`
- Principal：`InteractiveToken`（登录时运行，不存密码）

### 9.2 macOS（launchd）
`~/Library/LaunchAgents/com.siteindex.{projectId}.{job}.plist`，`StartCalendarInterval` 数组（每个周几一项，Weekday 0=周日）；`launchctl bootstrap gui/$(id -u)`。睡眠错过的任务唤醒后执行一次。

### 9.3 执行前检查
项目可读（云盘已挂载、非占位文件）→ 执行设备 → 运行锁 → 执行 → runs.jsonl → 释放锁 → 通知。`validate_after_sync=true` 时 daily/weekly 结束后对写入的文件做校验并更新 validation.json。

## 10. 各 Job 要点

| Job | 步骤 | 参考实现 |
|---|---|---|
| daily | 下载 feed → 解析 → 分类计算 → 合并（基线、保护阈值、missing_as、overrides）→ 事件 → 汇总 → 日报 → views（products、sku_stock）→ 校验 | `reference/scripts/crawl/gmc_feed.py`、`inventory_update.py`、`build_views.py` |
| weekly | sitemap 展开 → 页面抓取（rate limit）→ seo/pages、issues、links → blog_index → product_details → categories（url_rule 模式在此识别分类页） | `gmc_feed.py` weekly 部分 + 新增 |
| monthly | robots、sitemaps.json、tech.json → design → 归档 | 新增 |
| validate | 第 6 节规则 → validation.json；`--repair` | `validate.py` + 新增 |
| readme | 区块解析/替换 → 6 个自动区块 | 新增 |
| design | playwright 打开首页/分类页/产品页（1440、390 宽）→ tokens.json、brand.md、截图 | 新增 |
| index-check | 见 10.1 | 新增 |

### 10.1 Google 收录检查（index-check）
- 单页：界面"检查收录"按钮直接用系统默认浏览器打开 `https://www.google.com/search?q=site:<url去协议>`，不写数据
- 批量：用 playwright + 系统浏览器（有界面、使用独立用户目录），逐个访问 site: 查询，每次间隔随机 20–40 秒，单次最多 50 个 URL；判断结果页是否包含该 URL；遇到验证码立即停止，剩余标为未检查并通知用户；结果写 `seo/pages.jsonl` 的 `google_indexed` 与 `index_checked_at`
- 这是尽力而为的检查，界面文案需说明"结果仅供参考，以 Search Console 为准"

## 11. 文件夹操作
- 新建：`mkdir` + 写 `_about.md` + 更新 `site.json.workspace_folders`
- 说明：只替换 `_about.md` 第一段
- 删除：仅自定义文件夹；`shell.trashItem()` 移到回收站
- 完成后标记 README `folder-map` 需要刷新（立即刷新该区块）

## 12. Skill 分发
内置 `skills/{name}/SKILL.md`（frontmatter 含 version）→ 项目 `_agent/skills/` + `manifest.json`；安装到平台目录（Claude Code `%USERPROFILE%\.claude\skills`，其他由用户配置）。skill 中命令统一写 `siteindex …`，并写明命令不可用时按 DATA_SPEC 直接读写文件。

## 13. 设置与本机状态
`%APPDATA%\SiteIndex\settings.json`（macOS `~/Library/Application Support/SiteIndex/`）：device_id、device_name、projects_root、extra_projects、cache_dir、browser、notify、skill_platforms、conflict_patterns。界面状态（列设置、每页条数、窗口）存 `{cache_dir}/{projectId}/ui-state.json`，不进云盘。

## 14. IPC
完整接口定义：`packages/shared/src/api.ts`（`SiteIndexApi`）。规则：
- preload 只做 `ipcRenderer.invoke` 透传，不写业务
- 所有路径参数在 main 中规范化并限制在项目目录内
- 列表接口一律分页：`{ page, pageSize, sort, filters, search } → { rows, total }`
- 事件：`jobs.onProgress`、`projects.onChanged`（文件变化）、`schedule.onChanged`

## 15. 打包与发布
- electron-builder：Windows `nsis`（`oneClick: false`、`perMachine: false`、允许改目录）；macOS `dmg`（universal）
- `resources/`：`cli.js`（tsup 打包 core+cli）、`skills/`、`templates/`、`schemas/`
- GitHub Actions：PR 跑 typecheck + test（windows-latest、macos-latest、ubuntu-latest）；打 tag `v*` 时构建安装包并上传 Release
- 不签名；README 写明 Windows SmartScreen"仍要运行"、macOS 右键"打开"

## 16. 安全
`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`（renderer）；CSP 禁止远程脚本；外链用 `shell.openExternal` 且只允许 http/https；抓取只访问项目配置的域名、feed、sitemap 与 Google 查询。
