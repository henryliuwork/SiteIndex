# 工作流 C · Desktop（Electron、系统集成、打包发布）

**负责目录**：`packages/desktop/`、`.github/workflows/`、`skills/`、`templates/`、根目录配置
**必读**：`docs/ARCHITECTURE.md`（全文）、`docs/WORKSTREAMS.md` §2（接口分工）、`packages/shared/src/api.ts`、`docs/PRD.md` §5.12–§5.14 与 §7–§8
**原则**：Windows 为主，macOS 兼容；安装后双击即用、不需要管理员、不依赖 Node 环境；**禁止原生模块**。

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
- [x] `.github/workflows/release.yml`：tag `v*` → windows-latest 构建 exe、macos-latest 构建 dmg → 上传到 GitHub Release
- [x] CI 增加：每个 PR 在 windows-latest 上执行 `pnpm --filter @siteindex/desktop build`（不打安装包）以尽早发现打包问题
- [x] **验收（M1 集成）**：从 Actions 下载 exe，在 Windows 11 上安装、打开，看到 mock/占位的项目中心

## M2 · 系统集成全部完成

### C4 设置与本机状态
- [x] `%APPDATA%\SiteIndex\settings.json`（mac `~/Library/Application Support/SiteIndex/`）；首次启动生成 device_id、默认 device_name（计算机名）
- [x] 首次启动引导选择项目根目录（`settings.chooseDirectory`）
- [x] `ui-state.json`：列设置、每页条数（与 B 约定 `useColumnPrefs` 的存储适配，通过一个额外的 `uiState` IPC，走契约流程添加）

### C5 接 core
- [x] `createCoreService({ resolveProject, deviceId, cacheDir })` 接到 IPC；`projects.list` 扫描 projects_root 与 extra_projects（有 `index/site.json` 的文件夹）；接通 projects、overview、inventory、products、seo、content、edm、readme、files core 方法
- [x] chokidar 监听各项目 `index/`、`README.md`（防抖 1 秒）→ `core.invalidate(path)` + `projects.onChanged`
- [x] 导出 CSV：保存对话框 → 写文件 → 返回路径

### C6 Job 执行
- [x] 每个 Job 一个 `utilityProcess`（入口打包 core 的 `runJob`）；进度转发到 `jobs.onProgress`；`cancel` 结束进程并释放锁
- [x] 同一项目同一时间一个 Job；`jobs.running`
- [x] **无界面模式** `SiteIndex.exe --run-job "<projectPath>" <job>`：不创建窗口，直接执行，完成后按设置发系统通知，退出码同 `EXIT`
- [x] 系统通知（失败通知 / 成功通知 / 缺货阈值）

### C7 系统计划任务 `src/main/scheduler/`
- [ ] Windows：按 ARCHITECTURE §9.1 生成 UTF-16LE XML（每周几、每月几号、StartWhenAvailable、WakeToRun、InteractiveToken、IgnoreNew、PT2H）→ `schtasks /Create /TN "\SiteIndex\{projectId}-{job}" /XML … /F`；删除用 `/Delete /F`；`next_runs` 用 `schtasks /Query /XML` 读取
- [ ] macOS：launchd plist（StartCalendarInterval 数组）→ `launchctl bootstrap gui/$UID`
- [ ] `schedule.save`：写 site.json（core）→ 本机是执行设备时注册/更新系统任务；不是执行设备时只保存并提示
- [ ] 软件启动时校正：执行设备上的项目，系统任务与 site.json 不一致时自动修正
- **验收**：XML 与 plist 生成有快照测试；Windows 上实测"工作日 02:00"任务注册成功并按时运行（PRD §8 场景 7）

### C8 执行设备、文件夹、外壳操作
- [ ] `runner.claim`：写 `.runner.json`（core）+ 在本机注册计划任务 + 提示原设备的任务将自动跳过
- [ ] `folders.remove`：`shell.trashItem`（仅自定义文件夹，core 先校验）；`folders.open`：`shell.openPath`
- [ ] `shell.openExternal` 只放行 http/https；`shell.copyText` 用 clipboard

### C9 Skill 分发 `skills/` + `src/main/skills/`
- [ ] 更新 7 个 skill：命令统一为 `siteindex …`；EDM 取图规则为"feed 首图优先 → 手动首图 → 不进入 EDM"；每个 skill 写明命令不可用时按 DATA_SPEC 直接读写文件
- [ ] frontmatter 含 `version`；`skills.list/get/targets/install/syncAllProjects`
- [ ] 安装目标：项目 `_agent/skills/` + `manifest.json`、Claude Code（`%USERPROFILE%\.claude\skills`）、Codex、自定义目录
- [ ] `templates/project/` 与 DATA_SPEC §1 一致（README 区块标记 `siteindex:auto`）

### C10 命令行安装与浏览器检测
- [ ] `settings.installCli`：Windows 写 `%LOCALAPPDATA%\SiteIndex\bin\siteindex.cmd` 并加入用户 PATH（注册表 `HKCU\Environment`，广播 WM_SETTINGCHANGE 或提示重开终端）；mac 写 `~/.local/bin/siteindex`
- [ ] `settings.detectBrowser`：按顺序找 Edge、Chrome（Windows 注册表/常见路径；mac `/Applications`）；把路径传给 A 的 design / index-check Job

## M3 · 发布
- [ ] macOS dmg 实测（arm64 + x64）
- [ ] 根 `README.md` 补充下载安装说明（SmartScreen"仍要运行"、mac 右键"打开"）、截图
- [ ] 打 tag `v0.1.0` 发布 Release
- [ ] 组织 PRD §8 的 8 个场景验收，记录在 issue `Milestone M3 集成`

## 交付给其他工作流
- 给 B：Electron 里的真实 `window.siteindex`；`uiState` 存储
- 给 A：浏览器路径、device_id、cacheDir 通过 `createCoreService(ctx)` 与 `runJob` 参数传入
