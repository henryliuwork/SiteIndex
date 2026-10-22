# SiteIndex · 界面设计规范

界面以 `design/demo/*.dc.html` 为准（21 个画板）。这些文件是设计稿源码，不是可直接运行的页面：结构、文案、颜色、间距、交互状态都照着实现，但用 React + Tailwind 重写。可交互的在线版本见 `design/README.md`。

## 1. 设计 token（写入 `packages/ui/src/styles/tokens.css`，Tailwind v4 `@theme`）

| token | 值 | 用途 |
|---|---|---|
| `--color-brand` | #1E6B52 | 主色：主按钮、选中、进度 |
| `--color-brand-strong` | #154D3B | 主色文字、hover |
| `--color-brand-soft` | #E3EFE9 | 选中背景、成功 chip |
| `--color-ink` | #1B1F24 | 正文 |
| `--color-ink-2` | #3D4550 | 次要文字、导航 |
| `--color-muted` | #5B6470 | 辅助说明（12px） |
| `--color-faint` | #8A939D | 占位、预留列文字 |
| `--color-line` | #E1E4E8 | 卡片边框、表头下边 |
| `--color-line-soft` | #EEF0F2 | 行分隔 |
| `--color-surface` | #FFFFFF | 卡片 |
| `--color-canvas` | #F4F5F7 | 内容区背景 |
| `--color-subtle` | #F8F9FA | 表头、浅底块 |
| `--color-warn` / `-soft` | #8A4B00 / #FFF1DB | 警告 |
| `--color-danger` / `-soft` | #A3200F / #FDE8E7 | 错误、缺货 |
| `--color-info` / `-soft` | #1F4E80 / #E6EEF8 | 信息、标签、台账 |
| `--color-neutral-soft` | #ECEEF1 | 中性 chip |
| 状态色块 | 有货 #2E8A63 · 缺货 #D64532 · 预售 #E0A33A · 未知 #C4C9CF | 库存 30 天色块 |
| 趋势线 | #1E6B52 · #D9822B · #7FB2E5 | 分类趋势（亮度差足够区分） |

字体：`"IBM Plex Sans", "Microsoft YaHei UI", "PingFang SC", sans-serif`；等宽 `"IBM Plex Mono", Consolas, monospace`（SKU、URL、路径、数字）。字体文件随安装包打包（不依赖网络）。
字号：页面标题 24/700 · 区块标题 15/600 · 正文 14 · 表格 13 · 辅助 12 · 指标数字 20–24/700。
圆角：窗口 12 · 卡片 10 · 按钮/输入/筛选/子标签 6 · chip 999。
间距：页面内边距 24×32；卡片内边距 14–22；元素间距 6/8/10/12/14/16/20。

## 2. 组件

| 组件 | 规格 |
|---|---|
| Button | 高 36（小号 32）；默认白底灰边；`primary` 主色填充；`danger` 红字红边；禁用 40% 透明 |
| FilterPill | 高 30、圆角 6、13px；选中主色填充白字 |
| Segmented | 高 32；选中深色 #1B1F24 填充；用于视图切换（问题/页面/内链） |
| SubTabs | 高 32、圆角 6；选中深色填充；用于设置子页 |
| Tabs | 高 44，下划线 2px 主色 |
| Chip | 圆角 999、12px/600；ok / warn / danger / info / neutral |
| LengthBadge | 圆角 4、等宽；绿 / 橙 / 红（SEO 字符数） |
| KpiCard | 白卡片，标签 12px 灰 + 数字 20–24/700 + 说明；可点击跳转；预留卡片用虚线边框 |
| DataTable | 外层卡片；**最大高度 520–560，内部滚动，表头 sticky**；行高 ≥ 44；可点击行 hover 与选中底色 #F2F8F5；右上"列设置"弹层（勾选列，持久化到 ui-state）；预留列表头灰底灰字 |
| DetailPanel | 表格右侧 320–400 宽；点击行出现；右上关闭；分区用细线分隔 |
| Popover | 白底、圆角 10、阴影 `0 12px 32px rgba(20,24,29,.16)` |
| Pagination | 32×32 页码按钮；每页 20/50/100 |
| StatusCells | 30 个 5×16 小方块，间距 1，左旧右新，带 aria-label 汇总 |
| WindowChrome | 标题栏高 38、白底、左侧 "SiteIndex"；窗口圆角 12（Windows 11 / macOS 原生） |
| SideNav | 宽 232；导航项高 40、圆角 6；选中 `brand-soft` 底 + `brand-strong` 字；下方项目列表带状态圆点 |

## 3. 页面与画板对照

| 画板 | 路由 | 页面 |
|---|---|---|
| Main | `/` | 项目中心 |
| NewProjectUrl / NewProject / NewProjectBrand / NewProjectDone | `/new/url` `/new/source` `/new/brand` `/new/done` | 新建向导 4 步 |
| Overview | `/p/:id` | 概览 |
| Inventory | `/p/:id/inventory` | 库存 |
| Products | `/p/:id/products` | 产品 |
| SEO | `/p/:id/seo` | SEO |
| Content | `/p/:id/content` | 内容 |
| Edm | `/p/:id/edm` | EDM |
| Design | `/p/:id/design` | 设计规范 |
| Readme | `/p/:id/readme` | README |
| Runs | `/p/:id/runs` | 运行与定时任务（侧栏"定时任务"进入当前项目的此页） |
| ProjectSettings / Categories / Folders / LocalFiles | `/p/:id/settings/config` `…/categories` `…/folders` `…/files` | 项目设置四个子页 |
| Skills | `/skills` | Skill 中心 |
| AppSettings | `/settings` | 软件设置 |
| DataSchema | — | 数据表结构说明（文档，不是页面） |

## 4. 交互规则
- 所有列表：搜索即时过滤（200ms 防抖）；筛选可组合；显示"显示 N / 总数"
- 行点击 → 详情面板；Esc 关闭
- 写入类操作（保存手动首图、标签、文件夹说明、分类、计划）：按钮旁显示"已保存"状态 2 秒；失败显示原因
- 危险操作（删除文件夹、删除标签、删除冲突副本）需二次确认
- 长任务：按钮变为进度态，日志面板实时滚动；可停止
- 空状态：说明原因 + 下一步按钮（如"尚未配置 feed → 去填写"）
- 键盘可达：所有可点击元素为 `button` / `a`；图标按钮有 `aria-label`；文字对比度 ≥ 4.5:1
- 窗口宽度 1100–1280 时侧栏可折叠为图标栏
