# 工作流 B · UI

**负责目录**：`packages/ui/`
**必读**：`docs/DESIGN.md`（全文）、`docs/PRD.md` §4–§5、`packages/shared/src/api.ts`、`design/README.md` 与 `design/demo/*.dc.html`（21 个画板，界面以此为准）
**原则**：只依赖 `@siteindex/shared`；所有数据通过 `window.siteindex`（`SiteIndexApi`）获取；浏览器中用 mock 独立运行，不需要 Electron。

技术：React 19、Vite、TypeScript、Tailwind v4（`@theme` token）、Radix UI（Popover/Dialog/Tooltip/Checkbox）、TanStack Table + TanStack Virtual、TanStack Query（数据获取与缓存失效）、React Router（hash 路由，Electron 用 `file://` 加载）、Recharts（趋势图）。字体 Geist Variable / Geist Mono Variable 与 Source Han Sans SC（使用 Noto Sans SC variable OFL-1.1 打包版）本地打包。

---

## M1 · 框架、通用组件、两个核心页面

### B1 工程
- [x] Vite + React + TS + Tailwind v4；`pnpm dev:ui` 在浏览器打开；`pnpm --filter @siteindex/ui build` 输出 `packages/ui/dist/`（相对路径 `base: "./"`，C 用 `file://` 加载）— [PR #7](https://github.com/henryliuwork/SiteIndex/pull/7)
- [x] `src/styles/tokens.css`：DESIGN §1 全部 token — [PR #7](https://github.com/henryliuwork/SiteIndex/pull/7)
- [x] `src/api.ts`：`export const api = window.siteindex ?? createMockApi()`；mock 只在 `import.meta.env.DEV` 或 `VITE_MOCK=1` 时打包进去 — [PR #7](https://github.com/henryliuwork/SiteIndex/pull/7)
- [x] 路由：DESIGN §3 全部路由，未实现页面先放占位 — [PR #7](https://github.com/henryliuwork/SiteIndex/pull/7)、[PR #34](https://github.com/henryliuwork/SiteIndex/pull/34)
- [x] `package.json` 加 `dev`、`build`、`typecheck`、`test` 脚本 — [PR #7](https://github.com/henryliuwork/SiteIndex/pull/7)

### B2 mock 层 `src/mock/`
- [x] `createMockApi(): SiteIndexApi`，**覆盖接口全部方法**（未用到的返回合理默认值），类型检查保证与契约一致 — [PR #10](https://github.com/henryliuwork/SiteIndex/pull/10)、[PR #80](https://github.com/henryliuwork/SiteIndex/pull/80)
- [x] `projects.addExisting(path)` 在 mock 中登记路径、刷新列表并拒绝归一化后的重复路径 — 本 PR
- [x] 数据来源：`fixtures/expected/project/index/`（Kingsyard 示例）+ 生成器扩充到 2 个项目、1 万 SKU（用于性能测试）；写一个 `scripts/build-mock-data.ts` 把 fixtures 转成 mock 用的 JSON — [PR #10](https://github.com/henryliuwork/SiteIndex/pull/10)
- [x] 模拟延迟（100–300ms）、Job 进度事件（`jobs.onProgress` 每 300ms 推一条）、可切换"错误场景"（URL `?mock=error`）— [PR #10](https://github.com/henryliuwork/SiteIndex/pull/10)

### B3 通用组件 `src/components/`（DESIGN §2）
- [x] Button、FilterPill（30px / 圆角 6）、Segmented、SubTabs、Tabs、Chip、LengthBadge、KpiCard（含预留虚线样式）、Popover、Dialog（二次确认）— [PR #12](https://github.com/henryliuwork/SiteIndex/pull/12)
- [x] **DataTable**：最大高度内部滚动、sticky 表头、行点击选中、列设置弹层（持久化到 localStorage 键 `si.cols.{tableId}`；Electron 中 C 会改为 ui-state，接口保持 `useColumnPrefs(tableId)` 不变）、预留列灰色、服务端分页（`ListQuery`）、排序、空状态 — [PR #12](https://github.com/henryliuwork/SiteIndex/pull/12)、[PR #16](https://github.com/henryliuwork/SiteIndex/pull/16)、[PR #80](https://github.com/henryliuwork/SiteIndex/pull/80)
- [x] DetailPanel（右侧 320–400，Esc 关闭）、Pagination（20/50/100）、StatusCells（30 格）、SearchInput（200ms 防抖）— [PR #12](https://github.com/henryliuwork/SiteIndex/pull/12)
- [x] WindowChrome（标题栏 38，整条为拖动区域；Windows 右侧按 Window Controls Overlay CSS 变量留出原生按钮空间，mac 左侧留 78px —— 用 `api.app.platform()` 判断）、SideNav（宽 232，可折叠为图标栏）— [PR #7](https://github.com/henryliuwork/SiteIndex/pull/7)、[PR #51](https://github.com/henryliuwork/SiteIndex/pull/51)
- [x] ProjectHeader：项目身份行 44px、Tab/页面标题/操作行 44px；共享操作菜单用于窄宽度下收纳低频操作 — [PR #365](https://github.com/henryliuwork/SiteIndex/pull/365)
- **验收**：组件有 vitest 单测（筛选、分页、长度标色、列设置持久化）
- [x] Drawer 打开时按遮罩层数合成并同步 Windows 原生 titleBarOverlay 颜色；最后一层关闭或卸载后恢复白色，缺少 bridge 时安全降级 — [PR #364](https://github.com/henryliuwork/SiteIndex/pull/364)

### B4 项目中心 `/` 与 库存页 `/p/:id/inventory`
- [x] 项目中心：PRD §5.1 全部内容；异常卡片高亮规则 — [PR #13](https://github.com/henryliuwork/SiteIndex/pull/13)、[PR #61](https://github.com/henryliuwork/SiteIndex/pull/61)
- [x] 项目中心“添加已有项目”回归：验证路径、项目 ID 路由、列表刷新与重复添加提示；FilterBar DOM 回归：两行内不折叠、超过两行可折叠，弹层不受内容区裁切 — 本 PR
- [x] 项目中心最近运行表使用列宽契约并统一虚拟行高；DESIGN 补列宽契约写法，DataTable DEV 告警检测缺少 meta/size 的列 — 本 PR
- [x] 项目中心待处理提醒可按项目展开，显示提醒数量与最近三条，并跳转到对应 SEO 待处理问题 — 本 PR
- [x] 项目中心待处理提醒支持标记已处理/忽略；方法缺失时隐藏操作，成功刷新项目摘要、提醒和 SEO 概览，失败只影响当前提醒 — 本 PR（目标 v0.1.10）
- [x] 项目中心支持按契约可选能力移除项目（确认仅取消登记），添加已有项目后非阻塞校验计划任务路径并显示结果 — 本 PR
- [x] 库存：PRD §5.4 全部内容；趋势图有 Y 轴 0–100% 与图例；SKU 明细表 1 万行 mock 下滚动/筛选无卡顿 — [PR #13](https://github.com/henryliuwork/SiteIndex/pull/13)、[PR #60](https://github.com/henryliuwork/SiteIndex/pull/60)
- **验收**：与画板 Main / Inventory 并排截图对比，结构与文案一致

## M2 · 全部页面

- [x] B5 新建向导 4 步（NewProjectUrl / NewProject / NewProjectBrand / NewProjectDone）：detect → inspectFeed → create；完成页订阅 Job 进度；品牌配置步仅配置品牌与项目位置，不管理工作区文件夹 — [PR #21](https://github.com/henryliuwork/SiteIndex/pull/21)、[PR #34](https://github.com/henryliuwork/SiteIndex/pull/34)、[PR #114](https://github.com/henryliuwork/SiteIndex/issues/114)
- [x] 无 GMC Feed 时，新建向导 mock 的 daily 步骤与 Core 一致返回 skipped；更新提示并覆盖非失败终态 — 本 PR
- [x] [Issue #102] 完成页按 `INIT_STEPS` 消费 init Job 的百分比、进度消息及最终成功/失败/跳过结果；调度重试核对 Desktop 返回的注册状态 — [PR #195](https://github.com/henryliuwork/SiteIndex/pull/195)。
- [x] B6 概览（Overview）：KPI 跳转、需要关注、复制 agent 指令；快捷操作打开项目文件夹 — [PR #22](https://github.com/henryliuwork/SiteIndex/pull/22)、[PR #34](https://github.com/henryliuwork/SiteIndex/pull/34)、[PR #114](https://github.com/henryliuwork/SiteIndex/issues/114)
- [x] B7 产品（Products）：标签增删、标签管理弹窗、详情面板（1:1 主图、Schema 胶囊）、预留销量列 — [PR #34](https://github.com/henryliuwork/SiteIndex/pull/34)、[PR #62](https://github.com/henryliuwork/SiteIndex/pull/62)
- [x] B8 SEO：三视图、详情面板全部字段、LengthBadge 红橙绿（用 shared 的 `gradeTitleLength`/`gradeDescriptionLength`）、"检查收录"→ `shell.openExternal(googleSiteUrl)`、"检查全部收录"→ `seo.checkIndex` + 进度 + "仅供参考，以 Search Console 为准" — [PR #24](https://github.com/henryliuwork/SiteIndex/pull/24)、[PR #34](https://github.com/henryliuwork/SiteIndex/pull/34)、[PR #63](https://github.com/henryliuwork/SiteIndex/pull/63)
- [x] B9 内容（Content）：三视图、分页、预留列 — [PR #34](https://github.com/henryliuwork/SiteIndex/pull/34)、[PR #64](https://github.com/henryliuwork/SiteIndex/pull/64)
- [x] B10 EDM：SKU 宣传图表、手动首图编辑保存、取图规则说明、edm-builder 指令面板 — [PR #34](https://github.com/henryliuwork/SiteIndex/pull/34)、[PR #65](https://github.com/henryliuwork/SiteIndex/pull/65)
- [x] B11 设计规范（Design）：点击色块复制色值（toast "已复制 #1E6B52"）— [PR #34](https://github.com/henryliuwork/SiteIndex/pull/34)、[PR #66](https://github.com/henryliuwork/SiteIndex/pull/66)
- [x] B12 README：用户区块编辑保存、自动区块列表；不再生成或展示目录地图 — [PR #34](https://github.com/henryliuwork/SiteIndex/pull/34)、[PR #114](https://github.com/henryliuwork/SiteIndex/issues/114)
- [x] B13 项目设置子页：配置 / 分类（三种模式、手动分类表与匹配规则、候选分类页、预览 → 保存）/ 本地文件（一键校验、按状态显示修复按钮）；取消文件夹管理页 — [PR #39](https://github.com/henryliuwork/SiteIndex/pull/39)、[PR #41](https://github.com/henryliuwork/SiteIndex/pull/41)、[PR #42](https://github.com/henryliuwork/SiteIndex/pull/42)、[PR #44](https://github.com/henryliuwork/SiteIndex/pull/44)、[PR #52](https://github.com/henryliuwork/SiteIndex/pull/52)、[PR #114](https://github.com/henryliuwork/SiteIndex/issues/114)
- [x] B14 运行与定时任务（Runs）：手动执行 + 实时日志 + 停止；历史；执行设备卡片；计划编辑（周几多选、时间、每月几号、四个选项）— [PR #45](https://github.com/henryliuwork/SiteIndex/pull/45)、[PR #55](https://github.com/henryliuwork/SiteIndex/pull/55)
- [x] v0.1.9 全项目定时任务汇总 `/schedules`：按项目筛选、显示每日/每周计划与最近/下次运行；行内加载错误隔离并可跳转配置 — [PR #273](https://github.com/henryliuwork/SiteIndex/pull/273)
- [x] 定时任务汇总接入可选校验/修复与孤立任务清理；Desktop 未实现时隐藏不可用操作 — 本 PR
- [x] B15 Skill 中心、软件设置 — [PR #46](https://github.com/henryliuwork/SiteIndex/pull/46)、[PR #48](https://github.com/henryliuwork/SiteIndex/pull/48)、[PR #73](https://github.com/henryliuwork/SiteIndex/pull/73)
- [x] 软件设置明确项目数据按设备保存在本机非同步目录，不暗示云盘同步同一项目；保留项目根目录选择 — 本 PR
- [x] v0.1.9 软件设置补充项目根目录用途与“移动或重新添加项目”说明 — [PR #275](https://github.com/henryliuwork/SiteIndex/pull/275)
- [x] 全部写入操作的"已保存 / 失败原因"反馈；危险操作二次确认；空状态与错误状态 — [PR #51](https://github.com/henryliuwork/SiteIndex/pull/51)、[PR #52](https://github.com/henryliuwork/SiteIndex/pull/52)、[PR #53](https://github.com/henryliuwork/SiteIndex/pull/53)、[PR #55](https://github.com/henryliuwork/SiteIndex/pull/55)、[PR #73](https://github.com/henryliuwork/SiteIndex/pull/73)

## M3 · 打磨
- [x] 新建向导网址与 Feed 表单中输入框、普通/小按钮垂直居中；共享 Input / Select / Button 在实际界面保持 14px — 本 PR
- [x] v0.5.5 软件设置的项目根目录输入框与“选择…”按钮顶边/高度对齐；1280/1920 前后截图与 640 窄屏点击验证 — 本 PR
- [ ] B-T3 共享层：DataTable 列设置置于常规工具栏槽位、FilterBar 超过两行可折叠、补充间距 token — 本 PR；D 页面样式中的 `top:-50px` / `padding-right:90px` 遗留规则未改，需由 D 清理
  - [x] FilterBar 按垂直重叠识别行，混合高度标签与 chip 不误折叠；折叠边界为第二行最大 bottom，并为焦点描边留白（本 PR）
- [x] 逐页对照画板修正细节；1100 宽窗口下布局不溢出（侧栏折叠）— [PR #51](https://github.com/henryliuwork/SiteIndex/pull/51)、[PR #60](https://github.com/henryliuwork/SiteIndex/pull/60)、[PR #61](https://github.com/henryliuwork/SiteIndex/pull/61)、[PR #62](https://github.com/henryliuwork/SiteIndex/pull/62)、[PR #63](https://github.com/henryliuwork/SiteIndex/pull/63)、[PR #64](https://github.com/henryliuwork/SiteIndex/pull/64)、[PR #65](https://github.com/henryliuwork/SiteIndex/pull/65)、[PR #66](https://github.com/henryliuwork/SiteIndex/pull/66)、[PR #67](https://github.com/henryliuwork/SiteIndex/pull/67)、[PR #68](https://github.com/henryliuwork/SiteIndex/pull/68)
- [x] B-T2：DataTable `height: number | "fill"`、表格区 flex 自适应（最小 320px）、表体滚动与分页条分离，`maxHeight` 弃用兼容 — 本 PR
- [x] 共享组件键盘焦点、Dialog/Drawer 焦点返回与文字对比度 — [PR #179](https://github.com/henryliuwork/SiteIndex/pull/179)
- [x] Tabs / ProjectHeader 稳定 tab 与 panel ID；README、软件设置面板建立 aria-controls / aria-labelledby 关系 — [PR #183](https://github.com/henryliuwork/SiteIndex/pull/183)
- [ ] 项目数据页接入 ProjectTabPanel；页面清单与归属待按 [issue #177](https://github.com/henryliuwork/SiteIndex/issues/177) 协调，不跨 D 文件边界
- [x] 10,000 SKU 浏览器 mock 交互：七类操作、两轮测试均低于 200 ms — [PR #69](https://github.com/henryliuwork/SiteIndex/pull/69)
- [x] [issue #88](https://github.com/henryliuwork/SiteIndex/issues/88) 浏览器 mock 首屏（Chrome 145、1100×720 / DPR 1.5）：项目中心 5 次冷会话 722–875 ms（中位数 804 ms），FCP 560–600 ms。库存页首批表格数据 1,356–1,484 ms（中位数 1,434 ms），单独记录，不与项目中心首屏混算 — [PR #184](https://github.com/henryliuwork/SiteIndex/pull/184)。截图：[项目中心](../../packages/ui/screenshots/issue-88-mock-project-center.png) / [10k SKU 库存页](../../packages/ui/screenshots/issue-88-mock-10k.png)
- [x] Electron source build 真实 preload / IPC 诊断基准（Electron 45、UI 0.1.4、`app.isPackaged=false`）：10,000 条合成 SKU 的 `inventory.listSkus` 5/5 成功，2.3–3.2 ms；库存页首批数据 5/5 成功，166–357 ms；冷启动到项目中心 2,087–2,150 ms。此记录不是安装包验收 — [PR #184](https://github.com/henryliuwork/SiteIndex/pull/184)。截图：[真实 IPC 的 10k SKU 表格](../../packages/ui/screenshots/issue-93-electron-10k-table.png)
- [ ] [issue #93](https://github.com/henryliuwork/SiteIndex/issues/93) 正式安装包验收：尚未验证，不得以浏览器 mock 或 Electron source build 结果代替
- [ ] 与 C 联调：真实 IPC 下全部页面可用（发现契约不一致 → 开 contract PR）— [issue #82](https://github.com/henryliuwork/SiteIndex/issues/82)，等待正式安装包验收
- [ ] 运行页系统计划任务 / 软件常驻状态与授权重新注册 — [PR #72](https://github.com/henryliuwork/SiteIndex/pull/72) 尚未合并

## v0.1.7 · 表格与规则
- [x] B-T1：DataTable 列宽契约、可见列 colgroup 重算、文本截断类与虚拟行高断言；宽度档位已写入 DESIGN — 本 PR

## v0.3.0 · 共享层收敛
- [x] B-2：DataTable v2 默认 fill、内部滚动与固定分页、50/100/200/全部、按 tableId 持久化、行选择与右侧固定操作列；#300 Playwright 回归 — 本 PR
- [x] B-3：`packages/ui/visual/` 的 `ui:check`，遍历所有路由并输出双视口布局/样式检查报告；干净工作树直接运行时自动生成 mock 数据（#347）— [PR #361](https://github.com/henryliuwork/SiteIndex/pull/361)。基线问题转 [#314](https://github.com/henryliuwork/SiteIndex/issues/314) / [#315](https://github.com/henryliuwork/SiteIndex/issues/315)
- [x] B-3 follow-up #360：表格页等网络请求完成后，再等待 DataTable、空态或错误态；加载状态优先于残留表格；Products、Inventory、EDM、SEO、分类页纳入双视口检查，填充表格同时检查表体与分页栏可见性。慢响应、空态、错误态和超时有单测 — [PR #369](https://github.com/henryliuwork/SiteIndex/pull/369)；路由与分页边界扩展 — 本 PR
- [x] B-3 follow-up：所有非表格路由也等待完成内容、显式全页空态或错误态；包含 Skills 顶层空列表；mock 请求未完成和持续加载不得提前截图；回归覆盖延迟完成、局部与全页空态、错误态及确定性超时 — 本 PR
- [x] B-4a 应用页迁移：项目中心与新建向导使用 PageHeader、Card、EmptyState、Notice、Drawer、Toast；向导步骤采用可插入数组并预留隐藏的 Agent 工作区插槽 — [PR #324](https://github.com/henryliuwork/SiteIndex/pull/324)
- [x] B-4b 应用页迁移：Skill 中心与软件设置使用 PageHeader、Card、EmptyState、Notice、Toast 和设计 token — [PR #327](https://github.com/henryliuwork/SiteIndex/pull/327)
- [x] B-4c 应用页迁移：README 与定时任务汇总页使用共享组件和 DataTable v2，页面字号、间距和颜色使用设计 token — [PR #331](https://github.com/henryliuwork/SiteIndex/pull/331)
- [x] B-5：`schedule.listSystemTasks` 只读区块，展示刷新状态、下次运行、配置一致性与差异；孤立任务继续调用 #291 的清理确认流程 — [PR #331](https://github.com/henryliuwork/SiteIndex/pull/331)
- [ ] C 联动：ui-state 持久化支持 200 / 全部 — [issue #307](https://github.com/henryliuwork/SiteIndex/issues/307)

## v0.4.0 · Agent 工作区
- [x] B4-1 / B-6：向导项目位置选择；按可选 `workspace.check/create` 显示 Agent 工作区步骤，默认启用、平台选择、Mailchimp 预设、目标目录空检查和目录树预览 — 浏览器 mock 与 UI 回归测试通过；Core/Desktop 源码 handler 已接入。未启动安装包，本记录不作为打包 IPC 验收
- [x] 项目中心“创建空工作区”：调用可选 `projects.createWorkspaceOnly`；浏览器 mock 验证创建后进入项目页；Core/Desktop 源码测试覆盖合成目录，不读取真实项目
- [x] B4-2 工作区导入检查 UI：项目中心“更多”菜单提供识别/检查；按 `auto_fixable` 显示补齐与手动处理项，显示 `repaired` 路径；浏览器 mock 验证补齐后仍保留 `site.json.workspace` 手工项
- [x] B4-3 软件设置与 Skill 中心：呈现托盘/开机选项；Skill 中心显示 Agents 通用目录、退役 `edm-builder` 且阻止安装/更新；mock 与回归测试覆盖 — 本 PR

## v0.4.1 · WordPress 凭据设置
- [x] 软件设置按项目 EDM 图片托管配置，按 HTTPS origin 分组并通过 `window.siteindexWindow.wordpressCredentials` 配置、替换、删除和重读本机凭据状态；用户名/密码不回显，提交后清空输入；浏览器 mock 只保存合成状态，不持久化凭据值 — [PR #412](https://github.com/henryliuwork/SiteIndex/pull/412)
- [x] 明确区分“本机凭据已保存”和“媒体上传未接通”；提示旧 `.env` 需用户自行迁移/移除，软件不会扫描或删除该文件 — [PR #412](https://github.com/henryliuwork/SiteIndex/pull/412)
- [x] 凭据 UI 区分 Desktop bridge 缺失与本机安全存储不可用；bridge 缺失/不完整时不显示无效重试或凭据管理操作，并覆盖 vault 重试恢复 — 本 PR
- [x] WordPress 凭据 UI smoke helper：按唯一 HTTPS origin 区块执行配置、实际替换、清除与无回显断言 — [PR #425](https://github.com/henryliuwork/SiteIndex/pull/425)；本 PR 增加 `configure` / `replace` / `delete` / `assert-status` 阶段及 `otherOrigins` 状态断言，供 E 在真实 stop/relaunch 后传入新 Page 检查双站点状态；进程生命周期仍由 E 管理。packaged Electron 调用方必须声明 APPDATA、LOCALAPPDATA、USERPROFILE、HOME、TEMP、TMP、项目根和 vault 均位于同一临时隔离根。helper 只做路径字符串检查，不证明实际环境或 junction 隔离，结果固定标为 UI-only，不代表真实 IPC
- [ ] 打包 Electron 凭据 UI/IPC 验收：等待 C/E 提供隔离 APPDATA、LOCALAPPDATA、合成项目根与临时 vault 的安全启动入口；mock 与 Desktop 假 transport/handler/vault 测试不能代替该验收

## 本机存储提醒与已识别同步目录只读提示（Issue #480 · B）
- [x] 项目中心与新建向导说明仅支持本机存储；明确未识别不代表已验证本机，转移需用户手动复制；现有项目共享页头及项目卡片提示已识别的第三方同步目录只读。项目中心隐藏该项目的同步、配置、导入检查及提醒状态写入入口，保留只取消登记且不删文件的显式移除入口 — [PR #484](https://github.com/henryliuwork/SiteIndex/pull/484)

## v0.5-W1 · 字体与共享项目页头
- [x] 全局和共享组件改用本地 Poppins（拉丁字重）与中英文系统回退；共享正文/控件字号最低 14px。Poppins 按 SIL OFL 1.1 随 UI 打包，不增加 npm 依赖。
- [x] ProjectHeader 在路由进入和字体加载后将活动 tab 滚入可见区；操作槽保留 420px/340px 固定宽度，缩紧按钮内边距并显示溢出滚动条；`ui:check` 检查按钮与活动 tab 不被裁切。
- [x] 最终 mock 截图：1280×800 与 1920×1080，见 `packages/ui/screenshots/v05-w1/`；42 个路由/视口检查中 39 项通过。余下 3 项仅在 D 负责的 EDM 页（“agent 使用”单元格裁切两项、1280×800 分页条出视口一项），本 PR 未改 D 页面。
- D 页面仍有 `font-size: 11–13px` 硬编码的文件：`content/page.css`、`runs/page.css`、`project-settings-files/page.css`、`project-settings-categories/page.css`、`project-settings-config/page.css`；需要 D 后续迁移到字号 token 才能满足全站 14px 下限。

## v0.5.1 · 工作区导入自动补齐体验
- [x] UI/mock 按 `workspace.importCheck` 的 `auto_fixable` / `repaired` 显示自动补齐 workspace 元数据；不可修复的异常仍提供明确手动处理说明。此 PR 只完成 UI 准备，整体验收与合并等待 A 提供安全的 Core 自动补齐实现。

## v0.5.2 · 新建项目 GMC Feed 可选
- [x] 新建项目向导允许跳过 GMC Feed，创建请求传空 `feed_urls`；明确提示创建后可在项目设置补充，并由 mock 展示无 Feed 时首次每日同步失败 — 本 PR

## v0.5.5 · 应用级 UI 体验复核
- [x] Playwright 复核项目中心、新建向导（网址与数据源步骤）、软件设置及常见表单控件，视口为 1280×800 与 1440×900；修正项目根目录“选择…”按钮的垂直偏位，并修复项目中心两个弹窗按 Escape 关闭后焦点未返回触发按钮的问题 — 本 PR。截图见 `packages/ui/screenshots/v055-ui-experience/`。
- [x] 为“添加已有项目”和“创建空工作区”补充 Escape 关闭后的焦点返回回归测试。该项不包含单独的字体字号专项。
- [x] ProjectHeader 在 1100×800 / 1280×800 下保留分类设置页标题与模式标签的完整宽度；标签栏承担收缩并可滚动，操作槽按钮保持可见。另记录当前 `/inventory` 兼容路由及其视口检查；该路由现展示 ProductsPage（#524）。Playwright 截图见 `packages/ui/screenshots/v055-project-header/` — 本 PR。
- [x] 项目导航只保留一个 `products` tab，显示“产品管理”并进入 `/products`；`/inventory` 作为兼容视图映射到同一 tab/tabpanel ID — 本 PR。

## v0.6.0 · W0 UI 规范与 token
- [x] 将 `--font-sans` 固定为 Geist Variable + Source Han Sans SC；Noto Sans SC variable（SIL OFL-1.1）随包离线提供，字号 token 与最小 10px 字号规范已更新。
- [x] 补齐间距映射、控件高度、InputWithAction、Tab 与日期时间约定；`ui:check` 对裸字号/裸色值/裸 px 间距/小于 10px 字号的新违规失败，并对同页多处日期时间输出复核告警。
- [x] AGENTS、WORKSTREAMS 阅读入口和 PR 模板已加入 UI/UX 硬性规范与检查项。
- [x] W1 共享样式迁移：styles 与共享组件样式改用字号、间距、颜色和阴影 token；共享样式基线减少 126 条，页面侧 499 条保留给逐页迁移 — 本 PR
- [x] W1 新建向导样式迁移：清除库存页 94 条过期基线，并将向导的 82 条基线全部迁移或清除；基线降至 323 条 — 本 PR
- [x] W1 项目中心样式迁移：页面间距改用 token，移除该页 48 条基线记录 — 本 PR
- [x] W1 Skill 中心样式迁移：页面间距改用 token，移除该页 35 条基线记录 — 本 PR

## v0.6.0 · W1 共享组件
- [x] `InputWithAction` 作为共享组件提供单测和 DESIGN 用法；新建向导、项目中心及软件设置的路径/检测/保存输入组合改用该组件 — 本 PR
- [x] W1 软件设置页的 31 条裸间距迁移到设计 token，样式基线只减不增 — 本 PR
- [x] W1 按当前样式扫描清理 D 已迁移页面的过期基线；README 自动区块时间标明来源并移出页头 — 本 PR

## v0.6.1 · 共享页头与说明提示
- [x] ProjectHeader 按 ResizeObserver 收纳项目 Tab，窄屏无横向滚动并在路由切换后恢复焦点；新增 InfoTooltip 与四档宽度的 ui:check 页头断言 — 本 PR
- [x] B 自有五页精简说明并接入 InfoTooltip；修正设置输入框和 Skill 按钮高度、非同步 Job 的页头标签，ui:check 检查 Tab 纵向滚动和计算高度 — 本 PR

## v0.6.2 · WooCommerce 站点探测向导
- [x] 按 #611 的可选字段展示 Sitemap 角色和分类前缀候选；无 Feed 可直接继续，分类规则支持多前缀并在创建后保存 — 本 PR

## v0.6.3 · 新建项目配置原子传入
- [x] 向导创建请求直接传入多前缀分类规则和 WooCommerce 无 Feed 自动采集开关；mock 在 init 前应用配置 — 本 PR

## v0.8.0 · 页面外框规范（G8.0-0）
- [x] B-0：将路线图 §3 规范写入 DESIGN，校对 AGENTS 摘要，新增项目头/区块间距/全局标题行 token，并更新 PR 模板；字体栈按 §1.1 调整且保留随包字体 — 本 PR
- [x] W0 可测量违例审计：按路线图 §4 记录页面、截图、条款和归属，提交 lead 冻结；不在本 PR 修改 D 页面 — 本 PR
- [x] G8.0-1 B-1a：共享 PageFrame 提供 global/project 外框及 content/table 滚动模式；旧页面待 G8.0-2 逐页迁移 — 本 PR
- [x] G8.0-1 B-1b：侧栏项目项两行显示项目名、平台与最近运行时间；域名放悬停标题，已识别同步目录显示警告图标 — 本 PR
- [x] G8.0-1 B-1c：ProjectHeader 在项目 PageFrame 内使用 48px 单行导航/操作；旧页面兼容至 G8.0-2 迁移 — 本 PR
- [x] G8.0-1 B-1d：InfoTooltip 长串折行与视口宽度限制；共享 TableSection 固定摘要/已选标签/表格节奏，PageFrame 内工具栏控件按 32px 对齐 — 本 PR
- [x] G8.0-1 B-3：`ui:check` §3.7 对已迁入 PageFrame 的路由执行硬断言；其余路由列入逐页旧外框基线并在迁入时强制移除；InfoTooltip 在所有路由上检查宽度和溢出 — 本 PR
- [x] G8.0-2 B-2a：项目中心迁入全局 PageFrame，删除其旧外框基线 — 本 PR
- [x] G8.0-2 B-2 共享表格前置：DataTable 支持左侧固定标识列及勾选列偏移，隐藏列后按可见列重新计算 — 本 PR
- [x] G8.0-2 B-2b：Skill 中心迁入全局 PageFrame 内容滚动模式，加载/空/失败状态同样使用外框，删除旧外框基线 — 本 PR
- [x] G8.0-2 B-2c：软件设置迁入全局 PageFrame 内容滚动模式，加载/失败状态同样使用外框，删除旧外框基线 — 本 PR
- [x] G8.0-2 B-2d：新建向导各步骤迁入全局 PageFrame 内容滚动模式，删除六个旧外框基线 — 本 PR
- [x] G8.0-2 B-2e：README 迁入项目 PageFrame 内容滚动模式，加载/失败状态保持外框，删除旧外框基线 — 本 PR
- [x] G8.0-2 产品页基线收敛：#720 已迁入 PageFrame，删除 `products` 与兼容路由 `inventory` 的旧外框基线 — 本 PR
- [x] G8.0-2 B-2f：未找到页面路由迁入全局 PageFrame 内容滚动模式，删除旧外框基线 — 本 PR
- [x] G8.0-2 EDM 基线收敛：#723 已迁入 PageFrame，删除 `edm` 旧外框基线 — 本 PR
- [x] G8.0-2 B-2g：定时任务汇总页迁入全局 PageFrame 表格滚动模式；系统任务与孤立任务在页头切换的紧凑区显示，保留校验、刷新和清理入口 — 本 PR
- [x] G8.0-2 内容页基线收敛：#725 已迁入 PageFrame，删除 `content` 旧外框基线 — 本 PR
- [x] G8.0-2 待办页基线收敛：#728 已迁入 PageFrame，删除 `project-todos` 旧外框基线 — 本 PR
- [x] G8.0-2 D9 设置页：三个完整路由仅允许 PageFrame 内容区滚动；深链与嵌入表格按实际滚动容器测量，删除三条旧外框基线 — 本 PR

## v0.8.2 · 间距规范与组件统一
- [x] B-0：路线图 §3.1–§3.7 规范写入 DESIGN；新增语义间距 token；PR 模板增加“影响面”表，AGENTS 摘要核对一致 — 本 PR
- [x] B-2：`ui:check` S1–S10 与 27 路由 × 2 视口 `spacing-baseline.json`；S7 沿用样式扫描 — 本 PR
- [x] B-1：共享 Tab、页头、间距、筛选/表单组件、DataTable help 与无值列 — 本 PR 收口
- [x] B-1a：项目 Tab 指示线与页头次要按钮按实测宽度显示；SummaryLine、Chip 按语义 token 留出内边距 — 本 PR
- [x] B-1c：DataTable 的 `meta.help` 表头说明、调用方明确标记整列无值时默认隐藏，以及 Segmented 容器 2px 内边距 — 本 PR
- [x] I7（B 页面）：README 根据 `missing_user_blocks` 提示缺失用户段，保存后读回状态清除提示 — 本 PR
- [x] D 类 #744：软件设置只提交变更字段与 revision，显式清空才附 clear；冲突保留草稿并提供刷新 — 本 PR
- [x] B-1b：共享 FilterPopover、带标签 Select 和 FilterCheckbox；统一 Select 弹层间距 — 本 PR
- [x] B-3：全局页逐页修复并移除 spacing 基线 — 本 PR 收口 B 范围
- [x] B-3 共享前置：InfoTooltip 图标按钮补紧凑内边距，统一修复 S2；各页基线随页面迁移删除 — 本 PR
- [x] B-3a：软件设置的 WordPress 凭据操作按钮统一 32px，并移除 `app-settings` 两视口间距基线 — 本 PR
- [x] B-3b：新建向导按钮与卖点输入框统一控件尺寸；Skill 列表使用可键盘选择的原生单选控件；移除两页的间距基线 — 本 PR
- [x] B-3c：共享表格列设置、排序表头和分页控件统一尺寸；项目中心与定时任务页移除间距基线 — 本 PR
- [x] B-3d：README 编辑按钮和刷新文案对齐规范；未找到页已为零问题，删除两页的间距基线 — 本 PR
- [x] #778：表头排序按钮与说明按钮按 DESIGN §3.5 保留 4px，并登记唯一 S3 例外；其他相邻控件仍按 8px 检查 — 本 PR
- [x] #781：共享 SearchInput 内层内边距、Segmented 选项高度、紧凑按钮文字留白对齐 S1/S2/S4；不调整检查阈值或 D 页面 — 本 PR
- [x] #781 后续：共享 FilterPill 按 32px 高、左右 12px 对齐 S1/S2，内容和 EDM 筛选按钮随组件统一 — 本 PR

## v0.8.5 · G8.5-1 UI 共享层
- [x] B-2：Button small、Segmented、SearchInput 与可排序表头按共享尺寸规范收敛；清理 spacing exception 并将上限降至 2；紧凑按钮保留不小于 50px 的命中宽度。27 路由 × 4 视口 `ui:check`：108/108 通过，0 新违规、0 例外、0 基线、0 时间告警 — 本 PR

## 交付给其他工作流
- [x] v0.7.5 B-1 / G7.5-0：五个板块页规范写入 DESIGN、AGENTS 与 PR 模板；共享 SummaryLine；ui:check §3.5 量化断言与五页现状基线 — 本 PR。页面结构迁移仍归 D，基线随对应页面达标逐页删除。
- [x] v0.7.5 G7.5-4（B 范围）：README 来源时间移入说明，状态格移除相对日期，控件高度与库存颜色使用现有 token；其余 B 页面时间显示已核对 — 本 PR。

- 给 C：`packages/ui/dist/`（`index.html` + 静态资源）；`useColumnPrefs` 可替换的存储适配点
- 不需要 A 的任何代码

### 给 D：项目页紧凑页头接入约定
- Tab 行右侧操作槽在宽屏固定为 420px、窄屏（≤900px）固定为 340px；即使当前页没有操作也保留槽位，避免按钮数量变化时 Tab 可用宽度重新分配。
- 项目身份行固定 44px，展示项目名、域名/平台和同步状态；Tab 行固定 44px。
- 页名若与当前 Tab 相同就省略；域名若已在项目身份行展示也省略。确有用处的短标题/数据日期放 `pageTitle` / `pageMeta`，操作按钮与 `overflow` 放同一行。
- D 页面移除独立 `PageHeader`，将它的 `title` / `meta` / `actions` / `overflow` props 合并到 `ProjectHeader`；`ProjectTabPanel` 的路由和 ARIA 关系保持原样。
- 接入时把主要且常用操作放入 `actions`；次要操作放 `overflow`，由共享键盘可达的“更多”菜单呈现，不要隐藏关键操作。例如：
  ```tsx
  <ProjectHeader project={project} activeTab="seo" hasTabPanel pageMeta={lastCrawlAt} actions={<Button onClick={refresh}>重新检查收录</Button>} overflow={[{ label: "导出 CSV", onSelect: exportCsv }]} />
  <ProjectTabPanel projectId={project.id} tab="seo">...</ProjectTabPanel>
  ```
- 2026-11-10 mock 复核：1280×800 与 1920×1080 下 Tab 均完整可见；EDM 的两个右侧操作都在固定槽内可见。共享“更多”菜单的键盘路径由 `project-header.test.tsx` 覆盖。仍需 D 把 `OverviewPage`、`ProductsPage`、`SeoPage`、`InventoryPage` 的独立 `PageHeader` 并入 `ProjectHeader`；截图显示这些页面仍保留第三行标题/操作区，业务页不在本 PR 修改范围。
- Products mock 在 1280×800 下，旧结构表格滚动区 320px；合并标题行并移除独立 `PageHeader` 后 417px，增加 97px。截图：[改造前](../../packages/ui/screenshots/compact-project-header-before-1280.png) / [改造后](../../packages/ui/screenshots/compact-project-header-after-1280.png)
- [x] v0.5.5 新建项目网址步骤“检测”按钮与 44px 输入框顶边/高度对齐；1280/1920/640 mock Playwright 量测并验证检测交互 — 本 PR
