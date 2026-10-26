# 工作流 B · UI

**负责目录**：`packages/ui/`
**必读**：`docs/DESIGN.md`（全文）、`docs/PRD.md` §4–§5、`packages/shared/src/api.ts`、`design/README.md` 与 `design/demo/*.dc.html`（21 个画板，界面以此为准）
**原则**：只依赖 `@siteindex/shared`；所有数据通过 `window.siteindex`（`SiteIndexApi`）获取；浏览器中用 mock 独立运行，不需要 Electron。

技术：React 19、Vite、TypeScript、Tailwind v4（`@theme` token）、Radix UI（Popover/Dialog/Tooltip/Checkbox）、TanStack Table + TanStack Virtual、TanStack Query（数据获取与缓存失效）、React Router（hash 路由，Electron 用 `file://` 加载）、Recharts（趋势图）。字体 IBM Plex Sans/Mono 本地打包（`@fontsource`）。

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
- [x] 数据来源：`fixtures/expected/project/index/`（Kingsyard 示例）+ 生成器扩充到 2 个项目、1 万 SKU（用于性能测试）；写一个 `scripts/build-mock-data.ts` 把 fixtures 转成 mock 用的 JSON — [PR #10](https://github.com/henryliuwork/SiteIndex/pull/10)
- [x] 模拟延迟（100–300ms）、Job 进度事件（`jobs.onProgress` 每 300ms 推一条）、可切换"错误场景"（URL `?mock=error`）— [PR #10](https://github.com/henryliuwork/SiteIndex/pull/10)

### B3 通用组件 `src/components/`（DESIGN §2）
- [x] Button、FilterPill（30px / 圆角 6）、Segmented、SubTabs、Tabs、Chip、LengthBadge、KpiCard（含预留虚线样式）、Popover、Dialog（二次确认）— [PR #12](https://github.com/henryliuwork/SiteIndex/pull/12)
- [x] **DataTable**：最大高度内部滚动、sticky 表头、行点击选中、列设置弹层（持久化到 localStorage 键 `si.cols.{tableId}`；Electron 中 C 会改为 ui-state，接口保持 `useColumnPrefs(tableId)` 不变）、预留列灰色、服务端分页（`ListQuery`）、排序、空状态 — [PR #12](https://github.com/henryliuwork/SiteIndex/pull/12)、[PR #16](https://github.com/henryliuwork/SiteIndex/pull/16)、[PR #80](https://github.com/henryliuwork/SiteIndex/pull/80)
- [x] DetailPanel（右侧 320–400，Esc 关闭）、Pagination（20/50/100）、StatusCells（30 格）、SearchInput（200ms 防抖）— [PR #12](https://github.com/henryliuwork/SiteIndex/pull/12)
- [x] WindowChrome（标题栏 38，`-webkit-app-region: drag`，Windows 右侧给原生按钮留 138px，mac 左侧留 78px —— 用 `api.app.platform()` 判断）、SideNav（宽 232，可折叠为图标栏）— [PR #7](https://github.com/henryliuwork/SiteIndex/pull/7)、[PR #51](https://github.com/henryliuwork/SiteIndex/pull/51)
- **验收**：组件有 vitest 单测（筛选、分页、长度标色、列设置持久化）

### B4 项目中心 `/` 与 库存页 `/p/:id/inventory`
- [x] 项目中心：PRD §5.1 全部内容；异常卡片高亮规则 — [PR #13](https://github.com/henryliuwork/SiteIndex/pull/13)、[PR #61](https://github.com/henryliuwork/SiteIndex/pull/61)
- [x] 库存：PRD §5.4 全部内容；趋势图有 Y 轴 0–100% 与图例；SKU 明细表 1 万行 mock 下滚动/筛选无卡顿 — [PR #13](https://github.com/henryliuwork/SiteIndex/pull/13)、[PR #60](https://github.com/henryliuwork/SiteIndex/pull/60)
- **验收**：与画板 Main / Inventory 并排截图对比，结构与文案一致

## M2 · 全部页面

- [x] B5 新建向导 4 步（NewProjectUrl / NewProject / NewProjectBrand / NewProjectDone）：detect → inspectFeed → create；完成页订阅 Job 进度 — [PR #21](https://github.com/henryliuwork/SiteIndex/pull/21)、[PR #34](https://github.com/henryliuwork/SiteIndex/pull/34)
- [x] B6 概览（Overview）：KPI 跳转、需要关注、复制 agent 指令 — [PR #22](https://github.com/henryliuwork/SiteIndex/pull/22)、[PR #34](https://github.com/henryliuwork/SiteIndex/pull/34)
- [x] B7 产品（Products）：标签增删、标签管理弹窗、详情面板（1:1 主图、Schema 胶囊）、预留销量列 — [PR #34](https://github.com/henryliuwork/SiteIndex/pull/34)、[PR #62](https://github.com/henryliuwork/SiteIndex/pull/62)
- [x] B8 SEO：三视图、详情面板全部字段、LengthBadge 红橙绿（用 shared 的 `gradeTitleLength`/`gradeDescriptionLength`）、"检查收录"→ `shell.openExternal(googleSiteUrl)`、"检查全部收录"→ `seo.checkIndex` + 进度 + "仅供参考，以 Search Console 为准" — [PR #24](https://github.com/henryliuwork/SiteIndex/pull/24)、[PR #34](https://github.com/henryliuwork/SiteIndex/pull/34)、[PR #63](https://github.com/henryliuwork/SiteIndex/pull/63)
- [x] B9 内容（Content）：三视图、分页、预留列 — [PR #34](https://github.com/henryliuwork/SiteIndex/pull/34)、[PR #64](https://github.com/henryliuwork/SiteIndex/pull/64)
- [x] B10 EDM：SKU 宣传图表、手动首图编辑保存、取图规则说明、edm-builder 指令面板 — [PR #34](https://github.com/henryliuwork/SiteIndex/pull/34)、[PR #65](https://github.com/henryliuwork/SiteIndex/pull/65)
- [x] B11 设计规范（Design）：点击色块复制色值（toast "已复制 #1E6B52"）— [PR #34](https://github.com/henryliuwork/SiteIndex/pull/34)、[PR #66](https://github.com/henryliuwork/SiteIndex/pull/66)
- [x] B12 README：用户区块编辑保存、自动区块列表、"待补充说明"跳到 设置 › 文件夹 — [PR #34](https://github.com/henryliuwork/SiteIndex/pull/34)
- [x] B13 项目设置四个子页：配置 / 分类（三种模式、手动分类表与匹配规则、候选分类页、预览 → 保存）/ 文件夹（默认不可删，删除二次确认）/ 本地文件（一键校验、按状态显示修复按钮）— [PR #39](https://github.com/henryliuwork/SiteIndex/pull/39)、[PR #41](https://github.com/henryliuwork/SiteIndex/pull/41)、[PR #42](https://github.com/henryliuwork/SiteIndex/pull/42)、[PR #44](https://github.com/henryliuwork/SiteIndex/pull/44)、[PR #52](https://github.com/henryliuwork/SiteIndex/pull/52)
- [x] B14 运行与定时任务（Runs）：手动执行 + 实时日志 + 停止；历史；执行设备卡片；计划编辑（周几多选、时间、每月几号、四个选项）— [PR #45](https://github.com/henryliuwork/SiteIndex/pull/45)、[PR #55](https://github.com/henryliuwork/SiteIndex/pull/55)
- [x] B15 Skill 中心、软件设置 — [PR #46](https://github.com/henryliuwork/SiteIndex/pull/46)、[PR #48](https://github.com/henryliuwork/SiteIndex/pull/48)、[PR #73](https://github.com/henryliuwork/SiteIndex/pull/73)
- [x] 全部写入操作的"已保存 / 失败原因"反馈；危险操作二次确认；空状态与错误状态 — [PR #51](https://github.com/henryliuwork/SiteIndex/pull/51)、[PR #52](https://github.com/henryliuwork/SiteIndex/pull/52)、[PR #53](https://github.com/henryliuwork/SiteIndex/pull/53)、[PR #55](https://github.com/henryliuwork/SiteIndex/pull/55)、[PR #73](https://github.com/henryliuwork/SiteIndex/pull/73)

## M3 · 打磨
- [x] 逐页对照画板修正细节；1100 宽窗口下布局不溢出（侧栏折叠）— [PR #51](https://github.com/henryliuwork/SiteIndex/pull/51)、[PR #60](https://github.com/henryliuwork/SiteIndex/pull/60)、[PR #61](https://github.com/henryliuwork/SiteIndex/pull/61)、[PR #62](https://github.com/henryliuwork/SiteIndex/pull/62)、[PR #63](https://github.com/henryliuwork/SiteIndex/pull/63)、[PR #64](https://github.com/henryliuwork/SiteIndex/pull/64)、[PR #65](https://github.com/henryliuwork/SiteIndex/pull/65)、[PR #66](https://github.com/henryliuwork/SiteIndex/pull/66)、[PR #67](https://github.com/henryliuwork/SiteIndex/pull/67)、[PR #68](https://github.com/henryliuwork/SiteIndex/pull/68)
- [ ] 键盘可达与 aria-label；对比度检查 — 待 [issue #81](https://github.com/henryliuwork/SiteIndex/issues/81) 合并后完成全页复核
- [ ] 性能：1 万 SKU mock 下任何操作 < 200ms；首屏 < 1 秒 — 交互基准待 [PR #69](https://github.com/henryliuwork/SiteIndex/pull/69) 合并；首屏指标待 [issue #88](https://github.com/henryliuwork/SiteIndex/issues/88)
- [ ] 与 C 联调：真实 IPC 下全部页面可用（发现契约不一致 → 开 contract PR）— [issue #82](https://github.com/henryliuwork/SiteIndex/issues/82)，等待 C 发布 v0.1.0-alpha.1 安装包
- [ ] 运行页系统计划任务 / 软件常驻状态与授权重新注册 — [PR #72](https://github.com/henryliuwork/SiteIndex/pull/72) 尚未合并

## 交付给其他工作流
- 给 C：`packages/ui/dist/`（`index.html` + 静态资源）；`useColumnPrefs` 可替换的存储适配点
- 不需要 A 的任何代码
