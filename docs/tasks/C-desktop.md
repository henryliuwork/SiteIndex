# 工作流 C · Desktop（Electron、系统集成、打包发布）

**负责目录**：`packages/desktop/`、`.github/workflows/`、`skills/`、`templates/`、根目录配置
**必读**：`docs/ARCHITECTURE.md`（全文）、`docs/WORKSTREAMS.md` §2（接口分工）、`packages/shared/src/api.ts`、`docs/PRD.md` §5.12–§5.14 与 §7–§8
**原则**：Windows 为主，macOS 兼容；安装与日常运行不需要管理员或 Node 环境；注册 Windows 系统计划任务需要一次 UAC 授权，拒绝或失败时改用软件常驻调度器；**禁止原生模块**。

技术：Electron（最新稳定版）、electron-vite、electron-builder（NSIS perUser + dmg universal）、chokidar、tsup（打包 cli.js）、playwright-core（浏览器检测，A 的 Job 调用）。

---

## M1 · 能安装、能打开

### C1 Electron 骨架

- [x] electron-vite：main、preload；开发时加载 `pnpm dev:ui` 的地址，生产加载 `packages/ui/dist/index.html`（`file://`，hash 路由）
- [x] 窗口：最小 1100×720、记住位置大小；Windows `titleBarStyle: "hidden"` + `titleBarOverlay`（高 38，颜色与标题栏一致）→ 原生圆角与系统按钮；macOS `hiddenInset`
- [x] 单实例锁（界面模式）；`--run-job` 模式不受单实例限制
- [x] 安全：`contextIsolation`、`sandbox`、CSP、外链只允许 http/https
- [x] `package.json` 加 `dev`、`build`、`typecheck`、`dist:win`、`dist:mac` 脚本

### C2 IPC 骨架

- [x] preload：用 `contextBridge.exposeInMainWorld("siteindex", api)` 暴露 `SiteIndexApi`，**只做 invoke 透传**；事件（onProgress / onFinished / onChanged）用 `ipcRenderer.on` 包装并返回 Unsubscribe
- [x] main：按命名空间注册 `ipcMain.handle("si:<ns>.<method>")`；错误统一转为 `SiteIndexError`
- [x] 契约测试：用类型保证 preload 暴露的对象 `satisfies SiteIndexApi`；单测遍历方法名与 handler 注册表一致
- [x] M1 期间 core 方法未就绪时返回 `NOT_IMPLEMENTED` 错误（界面显示占位）

### C3 打包与 CI

- [x] electron-builder：Windows NSIS（`oneClick: false`、`perMachine: false`、可改安装目录、桌面与开始菜单快捷方式、中文安装界面）；macOS dmg universal
- [x] `resources/`：`cli.js`（A 的 tsup 产物）、`skills/`、`templates/`、`schemas/`、字体
- [x] C-2：将 UI 构建产物中的字体文件复制到安装包 `resources/fonts/`；回归测试覆盖 Geist 与 Geist Mono 字体资源。实际字体文件随 B-1 的 UI 构建接入
- [x] `.github/workflows/release.yml`：tag `v*` → windows-latest 构建 exe、macos-latest 构建 dmg → 上传到 GitHub Release
- [x] CI 增加：每个 PR 在 windows-latest 上执行 `pnpm --filter @siteindex/desktop build`（不打安装包）以尽早发现打包问题
- [x] **验收（M1 集成）**：从 Actions 下载 exe，在 Windows 11 上安装、打开，看到 mock/占位的项目中心

## M2 · 系统集成全部完成

### C4 设置与本机状态

- [x] `%APPDATA%\SiteIndex\settings.json`（mac `~/Library/Application Support/SiteIndex/`）；首次启动生成 device_id、默认 device_name（计算机名）
- [x] 首次启动引导选择项目根目录（`settings.chooseDirectory`）
- [x] `ui-state.json`：列设置、每页条数（与 B 约定 `useColumnPrefs` 的存储适配，通过一个额外的 `uiState` IPC，走契约流程添加）
- [x] 设置读改写按文件路径串行化；原子写入使用唯一临时文件名；读取只在设置缺失、损坏或需要规范化时修复写回

### C5 接 core

- [x] `createCoreService({ resolveProject, deviceId, cacheDir })` 接到 IPC；`projects.list` 扫描 projects_root 与 extra_projects（有 `index/site.json` 的文件夹）；接通 projects、overview、inventory、products、seo、content、edm、design、categories、readme、files core 方法；`seo.checkIndex` 通过 JobManager 在 utilityProcess 执行 `index-check`
- [x] chokidar 监听各项目 `index/`、`README.md`（防抖 1 秒）→ `core.invalidate(path)` + `projects.onChanged`
- [x] 导出 CSV：保存对话框 → 写文件 → 返回路径

### C6 Job 执行

- [x] 每个 Job 一个 `utilityProcess`（入口打包 core 的 `runJob`）；进度转发到 `jobs.onProgress`；cancel、正常完成或进程崩溃后，Desktop 在确认 utilityProcess 退出时仅清理其自有锁；`--run-job` 等待清理完成再退出
- [x] 同一项目同一时间一个 Job；`jobs.running`
- [x] **无界面模式** `SiteIndex.exe --run-job "<projectPath>" <job>`：不创建窗口，直接执行，完成后按设置发系统通知，退出码同 `EXIT`
- [x] 系统通知（失败通知 / 成功通知 / 缺货阈值）

### v0.1.1 · 新建项目初始化

- [x] `projects.create` 建档后认领本机执行设备，并由 utilityProcess 启动 `jobs.run({ job: "init" })`；返回实际 IPC runId
- [x] Core init 结束后执行 `schedule`：沿用系统计划任务与 UAC 流程，向界面推送进度，替换 `JobResult.steps` 的占位结果，再触发 `onFinished`
- [x] 检查向导选定的项目根目录；与默认根目录不同的项目写入 `extra_projects`，init 前不提前注册计划任务
- [ ] 安装 v0.1.1 后在 Windows 完整验收新建项目流程与向导 8 步结果

### C7 系统计划任务 `src/main/scheduler/`

- [x] Windows：按 ARCHITECTURE §9.1 生成 UTF-16LE XML（完整 whoami 用户、InteractiveToken、LeastPrivilege、每周几 / 每月几号、StartWhenAvailable、WakeToRun、IgnoreNew、PT2H）；先以普通权限运行 `schtasks /Create` / `/Delete`。遇到 `0x80070005` 时将全部项目任务变更合并到一个临时 PowerShell 脚本，提示一次 UAC 并以 `Start-Process -Verb RunAs -Wait` 执行，读取 JSON 并逐项核验结果
- [x] UAC 被拒绝或提权失败后切换软件常驻调度器；Windows 托盘退出菜单与登录自启仅在常驻模式启用。启动自动校正不弹 UAC，保留之前选定的模式并设置授权待更新状态
- [ ] 运行页显示“系统计划任务”/“软件常驻（关闭软件后不执行）”模式；提供“重新授权注册”按钮（等待 contract PR 与 B 的 UI 更新）
- [x] macOS：launchd plist（StartCalendarInterval 数组）→ `launchctl bootstrap gui/$UID`
- [x] `schedule.save`：写 site.json（core）→ 本机是执行设备时注册/更新系统任务；遇到权限错误时提示一次 UAC，根据授权结果继续系统任务或切换常驻；不是执行设备时只保存并提示
- [x] 添加已有项目在项目登记与摘要读取完成后立即返回；系统任务 reconcile 进入后台串行队列，项目中心已有的任务核验状态等待后台注册完成；注册器先比较现有配置、批量读取候选旧任务、并发执行独立任务操作，只对确实失败的变更发起一次 UAC
- [x] 软件启动时校正：执行设备上的项目，系统任务与 site.json 不一致时自动修正；如需提权，仅在运行页显示授权待更新，不自动弹出 UAC
- [x] v0.3.0 C-2：`schedule.listSystemTasks` 只读枚举 Windows 任务计划程序和 macOS LaunchAgents，返回任务状态、运行结果、下次触发、触发摘要、命令路径、项目归属与配置差异；Windows 提供上次运行时间，launchd 不提供上次运行时间时返回 `null`
- [x] XML 与 plist 生成快照测试（覆盖 Windows 用户身份、权限级别、UTF-16LE、唤醒和补跑设置）
- [x] **验收**：本机 Windows 实测工作日 17:44 计划经 UAC 保存，任务计划程序于 17:44 触发，`runs.jsonl` 在 17:44:03 写入 `trigger=schedule`。另一次在应用完全退出后，系统任务于 17:26 触发。合成项目没有 Feed 快照，Job 按预期记录为失败；计划触发验收通过。运行页与运行历史截图见 `packages/desktop/docs/screenshots/c7-windows-scheduler.png` 和 `packages/desktop/docs/screenshots/c7-windows-run-record.png`。
- **文档交接**：本 PR 描述提醒审核者同步更新 `docs/ARCHITECTURE.md` §9.1 中 Windows 注册、一次性提权与常驻回退方案

### C8 执行设备、文件夹、外壳操作

- [ ] `runner.claim`：写 `.runner.json`（core）+ 在本机注册计划任务 + 提示原设备的任务将自动跳过
- [x] 工作目录管理已取消：`folders.list/create/describe/remove` 仅为兼容契约返回空数组；`folders.open` 只打开项目根目录，既有目录与 `_about.md` 不变
- [x] `shell.openExternal` 只放行 http/https；`shell.copyText` 用 clipboard

### C9 Skill 分发 `skills/` + `src/main/skills/`

- [x] 新增 `siteindex-data` 基础 skill，并将 7 个场景 skill 改为数据读取、筛选判断和台账写入流程；所有 skill 版本为 `1.1.0`，不再指定固定成果目录
- [x] 所有 skill frontmatter 含 `version: 1.1.0` 与数据读写范围
- [ ] `skills.list/get/targets/install/syncAllProjects`
- [ ] 安装目标：项目 `_agent/skills/` + `manifest.json`、Claude Code（`%USERPROFILE%\.claude\skills`）、Codex、自定义目录
- [x] 删除 `templates/project/_about.md`；README 模板和生成样例移除 `folder-map` 与固定工作区目录规则

### C10 命令行安装与浏览器检测

- [ ] `settings.installCli`：Windows 写 `%LOCALAPPDATA%\SiteIndex\bin\siteindex.cmd` 并加入用户 PATH（注册表 `HKCU\Environment`，广播 WM_SETTINGCHANGE 或提示重开终端）；mac 写 `~/.local/bin/siteindex`
- [ ] `settings.detectBrowser`：按顺序找 Edge、Chrome（Windows 注册表/常见路径；mac `/Applications`）；把路径传给 A 的 design / index-check Job

## M3 · 发布

- [ ] macOS dmg 实测（arm64 + x64）
- [ ] 根 `README.md` 补充下载安装说明（SmartScreen"仍要运行"、mac 右键"打开"）、截图
- [x] 自动更新：Electron 主进程经 `electron-updater` 检查 GitHub Releases，用户确认后下载；Job 完成后退出安装；macOS 未签名时提供手动 Release 地址
- [x] 发布构建：GitHub publish 元数据、Windows `latest.yml`、macOS `latest-mac.yml` 与 zip、blockmap；tag 与 desktop version 一致才允许发布
- [ ] A/B/C 的 init、新建完成页和自动更新全部合并后，打 `v0.1.1` 正式 Release

### 发版步骤

1. 在 `packages/desktop/package.json` 将 `version` 改为目标版本（如 `0.1.1`），单独提交 PR 并等待合并，确保三系统 CI 全绿。
2. 从合并后的 `main` 打对应 tag（如 `v0.1.1`）并推送；Release workflow 会校验 tag 与 Desktop 版本相同。
3. 等 Release workflow 完成并将草稿发布为正式 Release。
4. 检查 Release 资产至少包含 `SiteIndex-Setup-{version}.exe`、`SiteIndex-{version}-universal.dmg`、`SiteIndex-{version}-universal.zip`、`latest.yml`、`latest-mac.yml` 和 `.blockmap`。
5. 发布 `v0.1.1` 后，将 Desktop 版本改为 `0.1.2` 并经 PR 合并，再发布 `v0.1.2` 测试版本；在 Windows 安装 `v0.1.1`，验证提示更新、手动下载、重启安装以及版本号变为 `0.1.2`。macOS 未签名版本仅验证手动下载入口。

- [ ] 组织 PRD §8 的 8 个场景验收，记录在 issue `Milestone M3 集成`

## v0.2.0 · 收敛开发

- [x] C1 / #163：Windows 安装包的 CLI bundle 将 Core schema URL 指向同级 `resources/schemas/`；缺少预期路径模式或 schema 资源时让资源准备失败；覆盖路径重写单测并完成 Windows 安装版 CLI 与 `--run-job` fixture 验收。
- [x] C-IPC-TEST：preload invoke 覆盖测试按 `PENDING_HANDLERS` 校验；pending 方法可缺席或提前实现，契约外方法仍失败，事件方法保持完整性检查。
- [x] C3 / #92：正常界面启动先创建并加载主窗口，再后台校正系统计划；隐藏调度启动仍在退出/驻留决策前完成计划校正；覆盖窗口先于后台计划校正启动与后台错误处理的测试。

## 交付给其他工作流

## v0.1.10 · 项目登记与任务核验

- [x] `projects.remove` 只取消本机登记；根目录项目写入 `hidden_projects`，重新添加时恢复；取消登记后校正系统任务，授权失败仍保留取消登记并返回原因。
- [x] scheduler 校正时缺失项目路径记录警告并跳过；Windows 旧任务因授权拒绝而保留时，保存为孤立任务供后续查询与清理。
- [x] `schedule.verify` 检查任务存在、Windows 触发时间/日期和命令路径；repair 调用统一校正与授权流程并复核。
- [x] `schedule.listOrphans` 只枚举 SiteIndex 任务；`removeOrphan` 二次确认后仅删除所选孤立任务。
- [x] Core SEO 状态方法已合并；Desktop IPC 直通 Core，覆盖单条/批量状态与整类规则忽略/取消忽略。`PENDING_HANDLERS` 清理按契约流程另开 PR。
- [x] `seo.getRuleSettings` 通过 Desktop handler 与 preload bridge 转发到 Core；`PENDING_HANDLERS` 清理按契约流程另开 PR。

- 给 B：Electron 里的真实 `window.siteindex`；`uiState` 存储
- 给 A：浏览器路径、device_id、cacheDir 通过 `createCoreService(ctx)` 与 `runJob` 参数传入

## v0.4 · C4-0

- [x] 新增三个脱敏 EDM skill：`siteindex-edm-plan`、`siteindex-edm-build`、`siteindex-edm-mc-send`，版本为 `1.0.0`；逐行检查敏感信息，路径通过 `workspace.json` 逻辑键解析。
- [ ] 增加公开安全扫描脚本；初始仅告警。
- [ ] 按模板草案新增 `templates/workspace/`。

## v0.4 · C4-1（不依赖 A4-3 的部分）

- [x] `close_to_tray` 默认开、`launch_at_login` 默认关；保存与旧设置迁移已接入。
- [x] 托盘支持打开、下次计划、立即同步和退出；退出时有运行中 Job 会确认。
- [x] 技能目标新增 `agents-dir`（`~/.agents/skills`）；同步时保留版本高于内置版本的本地副本。
- [x] 从内置分发移除 `edm-builder`；发现已安装副本时返回退役状态，不自动删除或重装。
- [x] `workspace.check/create`、`workspace.importCheck` 已接入 Desktop IPC；导入检查有修复文件时立即失效 Core 项目缓存，目录监听负责变更通知。`PENDING_HANDLERS` 清理单独走 contract PR。
- [x] 打包资源脚本复制完整 `templates/` 与 `skills/`，Core 的 `templateDir` 相邻路径可解析 `templates/workspace/`；由 Desktop 资源测试覆盖。
- [x] `projects.createWorkspaceOnly` Desktop IPC：只创建空工作区，不启动 Job；按 `projects_root` / `extra_projects` 注册，支持 legacy 与 workspace 项目扫描、去重、解析和变更监听；同域并发创建串行检查。`PENDING_HANDLERS` 仍需等 handler PR 合并后经独立 contract PR 清理。
- [x] 空工作区创建后的设置登记写入失败时返回 `WRITE_FAILED`，说明已创建文件保留并指引“添加已有项目”恢复；Desktop 集成测试覆盖失败后恢复登记。

## Windows 原生标题栏桥接

- [x] preload 暴露 Desktop-only `window.siteindexWindow.setTitleBarOverlayColor("#RRGGBB")`；主进程仅接受来自主窗口主 frame 的六位十六进制颜色，仅更新 Windows 原生标题栏背景，关闭窗口时移除监听。
- [ ] B 在 Drawer 打开时设置遮罩混合色，关闭时恢复 `#FFFFFF`。

## v0.3 · #345 Windows 安装资源

- [x] Windows 自定义目录覆盖安装 v0.1.9 → v0.3.0；安装后两次重启均通过 CDP 确认加载 `resources/ui/index.html`。
- [x] `dist:win` 与 `dist:win:release` 增加两次静默自定义目录安装检查；核对全部 UI 文件与本次构建产物的 SHA-256，缺失或不一致时失败。
- [x] 将 UI 同时收进 `app.asar`；外置 `resources/ui` 缺失时主进程改载归档副本，双重加载都失败才进入 fallback。
- [ ] issue #345 的间歇性资源缺失根因未复现；继续收集安装器异常退出与覆盖安装证据。

## v0.4.1 · #422 / #423 Desktop 接入边界

- [x] #422：`before-quit` 等待 `jobs.shutdown()`；Desktop 对已启动的 Job 结束 utilityProcess、清理自有锁并将取消/崩溃作为失败结果返回。虚构双项目测试覆盖媒体凭据与进度/历史按项目隔离；不访问用户 vault。
- [x] #422：媒体能力闸保持关闭；`media.prepare` 在设置、凭据 accessor 与 utilityProcess 之前返回 `NOT_IMPLEMENTED`（PR #427）。
- [x] #422：JobManager 的锁清理、合成历史写入与 `jobs.history` 查询统一按 Core 的 `pathsForProject()` 解析 legacy/workspace 布局；worker runId 也从对应 `site.json` 读取时区。退出、崩溃、跨项目凭据隔离测试覆盖两种布局；暂停/退出与布局解析并发时不会再启动 worker。
- [x] #422：media worker 结果先校验完整恢复分区；缺字段或分区无效时拒绝把它当成功，取消/崩溃结果把无法确认项记为 `outcome_unknown` 并写入合成 RunLog。legacy/workspace 的退出与崩溃测试覆盖写入路径、项目隔离和凭据不泄漏；`jobs.history` 与 preload 透传字段，不为旧 RunLog 补造空结果。
- [x] #422：preload 暴露 `media.prepare` 路由；主进程仍在 `isMediaJobReady: false` 下返回 `NOT_IMPLEMENTED`，`media.prepare` 继续留在 `PENDING_HANDLERS`，Core 能力就绪前 UI 保持关闭。
- [ ] #422：A 尚未实现 Core media Job 及其逐 SKU RunLog 持久化；实时媒体处理与 Core 生成的恢复结果尚不可用。
- [x] #423：preload 暴露 `edm.exportIndex`；Desktop 先检查显式 readiness 门禁，再转发到 Core 可选方法。main readiness 当前固定为 false，即使 Core 暴露同名方法仍返回 `NOT_IMPLEMENTED`；尚未清理 `PENDING_HANDLERS`，UI 仍关闭导出入口。
- [ ] #423：A 尚未实现 Core SKU 清单生成；Desktop 不生成文件、不返回虚构成功状态。
