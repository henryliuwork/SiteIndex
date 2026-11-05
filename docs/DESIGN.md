# SiteIndex · 界面设计规范 v2

界面结构与文案以 design/demo/*.dc.html 画板为参考，数据与交互行为遵循当前 PRD 和 API 契约。v0.3 起，全局字号、间距、基础组件、页面操作区与表格遵循本规范；新增页面不得自创基础视觉值。

## 1. 设计 token

所有 token 定义在 packages/ui/src/styles/tokens.css。页面样式使用语义 token，不写裸色值；字号使用本节的字号 token。字体文件随 UI 包打包，不依赖网络。

### 1.1 颜色

| token | 值 | 用途 |
|---|---|---|
| --color-brand | #1E6B52 | 主按钮、选中态、进度 |
| --color-brand-strong | #154D3B | 主色文字、hover |
| --color-brand-soft | #E3EFE9 | 选中背景、成功 chip |
| --color-ink | #1B1F24 | 正文 |
| --color-ink-2 | #3D4550 | 次要文字、导航 |
| --color-muted | #5B6470 | 辅助说明 |
| --color-faint | #626D78 | 占位、预留列文字 |
| --color-line | #E1E4E8 | 卡片边框、表头下边 |
| --color-line-soft | #EEF0F2 | 行分隔 |
| --color-surface | #FFFFFF | 卡片与弹层 |
| --color-canvas | #F4F5F7 | 内容区背景 |
| --color-subtle | #F8F9FA | 表头、浅底块 |
| --color-warn / --color-warn-soft | #8A4B00 / #FFF1DB | 警告文字与背景 |
| --color-danger / --color-danger-soft | #A3200F / #FDE8E7 | 错误、缺货文字与背景 |
| --color-info / --color-info-soft | #1F4E80 / #E6EEF8 | 信息文字与背景 |
| --color-neutral-soft | #ECEEF1 | 中性 chip 背景 |
| --color-stock-in/out/preorder/unknown | #2E8A63 / #D64532 / #E0A33A / #C4C9CF | 库存 30 天状态格 |
| --color-chart-feeders/baths/houses | #1E6B52 / #D9822B / #7FB2E5 | 分类趋势图 |

页面 CSS 不得出现 #xxxxxx、rgb() 等裸色值。新增颜色先在 tokens.css 定义语义 token，再在组件中引用。

### 1.2 字体与字号

正文和标题使用 Geist Variable；SKU、URL、路径、数字等使用 Geist Mono Variable。中文回退 Microsoft YaHei UI、PingFang SC。不要加载远程字体。

| token | 字号 / 行高 | 字重 | 用途 |
|---|---:|---:|---|
| --fs-page-title | 20px / 28px | 600 | 页面标题、项目名 |
| --fs-section-title | 15px / 22px | 600 | 卡片与区块标题 |
| --fs-sub-title | 13px / 20px | 600 | 子区块、抽屉分组标题 |
| --fs-body | 12px / 18px | 400 | 默认正文、表格单元格、按钮、输入框 |
| --fs-caption | 11px / 16px | 400 | 辅助说明、表头小字、徽标 |
| --fs-kpi | 24px / 30px | 600 | 指标数字 |
| --fs-mono | 12px / 18px | 400 | 等宽内容 |

表头使用 12px、字重 600、muted 色；文字对比度不低于 4.5:1。页面 CSS 不得新增裸 px 字号；确需新层级时先扩展 token。

### 1.3 间距、圆角与阴影

| token | 值 | 常见用途 |
|---|---:|---|
| --space-1 | 4px | 紧凑图标间距 |
| --space-2 | 8px | 控件内部与紧邻元素 |
| --space-3 | 12px | 表单项、按钮组 |
| --space-4 | 16px | 卡片内边距、区块间距 |
| --space-5 | 20px | 中等区块间隔 |
| --space-6 | 24px | 页面内边距 |
| --space-7 | 32px | 大区块间隔 |
| --space-8 | 40px | 页面级留白 |

按钮、输入、筛选圆角 6px；卡片 8px；Drawer 与弹层 12px；chip 使用胶囊圆角。卡片内边距 16px，表单项间距 12px，区块间距 16px。新样式只用 4px 的倍数。

| token | 值 | 用途 |
|---|---|---|
| --shadow-pop | 0 12px 32px rgba(20, 24, 29, 0.16) | Popover、下拉菜单等浮层 |
| --shadow-drawer | -12px 0 32px rgba(20, 24, 29, 0.16) | 右侧 Drawer |

卡片和普通页面元素不加阴影。历史 --si-gap-* 只为尚未迁移的页面保留；新组件和迁移后的页面必须使用 --space-*。逐页清理在 B-4 完成。

## 2. 基础组件

B 维护 packages/ui/src/components/ 中的共享组件。页面组合这些组件，不复制基础交互与状态样式。

| 组件 | 规范 |
|---|---|
| Button | 高 32px，小号 28px；primary / secondary / ghost / danger。每个操作区最多一个 primary；图标按钮必须有 aria-label 和 tooltip。 |
| Input / Select / Checkbox | 控件高 32px，聚焦环统一。Select 使用 Radix Select/Popover，不用原生 select。 |
| FilterBar | 筛选下拉优先于 pill；内容超过两行时可折叠，最多两行时不显示“更多筛选”。 |
| Chip | ok / warn / danger / info / neutral；字号使用 --fs-caption、字重 600。处理状态等状态列统一使用 Chip。 |
| Card / KpiCard | 卡片圆角 8px、内边距 16px；标题使用 --fs-section-title；KPI 数字使用 --fs-kpi。可点击卡片提供 hover 和 focus 状态。 |
| Drawer | 右侧滑出，标准宽 480px，宽内容 720px；标题和关闭按钮固定，内容区独立滚动；支持 Esc、焦点陷阱和关闭后焦点返回。行详情、规则设置、趋势与配置类面板使用 Drawer。 |
| Toast | 由 ToastProvider 提供全局右上角堆叠，并通过 useToast 调用。成功 3 秒后消失；错误需用户手动关闭。写操作结果通过 Toast 呈现，不在标题下方保留临时状态文案。 |
| Notice | 内容区顶部的持续性横幅，支持 info / warn / error、图标和可选操作。用于需用户持续处理的状态。 |
| EmptyState | 显示图标、空状态原因和下一步操作按钮。 |
| PageHeader | 统一提供 title、meta、actions 和 overflow；项目页按“项目头 → Tabs → 页面操作栏 → 内容”排列。操作区规则见 §3。 |
| DataTable | 统一表格滚动、列宽、分页、行选择和操作列行为；页面不得自行包一套表格滚动容器。完整标准见 §2.1。 |

### 2.1 DataTable v2

页面窗口不纵向滚动。表格工具栏固定；表头 sticky；表体在 .si-table-scroll 内部纵向滚动；分页栏位于滚动区外并固定可见。表格区域默认填满页面剩余高度，最小高度 320px；窗口过矮时由内容区滚动兜底。非表格页的内容区可独立滚动。

底部分页栏左侧显示“显示 a–b / 共 N 条”，右侧提供每页 50 / 100 / 200 / 全部。默认每页 50，选择按 tableId 持久化到 ui-state。“全部”模式不分页，必须启用行虚拟化。行选择列可选；操作列通过 meta.sticky: "right" 固定在右侧。行内操作须阻止事件冒泡，且有点击回归测试。点击数据行打开 Drawer。

height 支持固定数值或 "fill"，默认 "fill"。不使用 maxHeight 兼容路径；表格高度由页面布局和 DataTable 的 height 契约控制。

表格行高与虚拟行高必须一致：单行 40px，两行省略 52px。虚拟滚动表格不使用 text: "wrap"。

### 2.2 DataTable 列宽契约

每列在 ColumnDef.meta 中声明 width / grow / minWidth / align / text。隐藏列后，列宽按当前可见列重算。低于所有列最小宽度之和时保留横向滚动。

| 内容类型 | width | grow | minWidth | text |
|---|---:|---:|---:|---|
| URL / 路径 | 320 | 2 | 220 | single |
| 标题 / 产品名 | 280 | 2 | 200 | clamp2 |
| 问题 / 描述 | 220 | 1 | 160 | clamp2 |
| 分类 / 标签 | 150 | 1 | 110 | single |
| SKU | 150 | 0 | 130 | single |
| 状态 / 级别 chip | 88 | 0 | 88 | single |
| 价格 / 数量（右对齐） | 96 | 0 | 80 | single |
| 日期 | 100 | 0 | 92 | single |

width 是基准宽度，grow 为剩余空间分配权重（0 固定、1 次要伸缩、2 主要伸缩），minWidth 为最小宽度，align 控制对齐，text 选择文本处理。.si-cell-1 单行省略并通过 title 提示全文，.si-cell-2 最多两行；两行省略使用 52px 行高。

禁止使用 TanStack size 代替 meta，DataTable 不读取 size。禁止使用 nth-child 设置列宽，隐藏或重排列后会错位。禁止使用 maxHeight；固定区域传数值 height，页面剩余空间使用 height="fill"。虚拟行高必须与 CSS 行高一致。

最小写法：

    const columns: ColumnDef<RunLog, unknown>[] = [
      { accessorKey: "started_at", header: "时间", meta: { width: 140, grow: 0, minWidth: 128, text: "single" } },
      { accessorKey: "summary", header: "摘要", meta: { width: 320, grow: 1, minWidth: 220, align: "start", text: "single" } },
    ];

    <DataTable tableId="runs.history" rows={rows} total={rows.length} columns={columns}
      query={query} onQueryChange={setQuery} height="fill" rowHeight={40} />

## 3. 页面骨架与右上角操作区

项目页统一骨架：项目头（名称、站点、同步状态）→ Tabs → 页面操作栏 → 内容。页面操作栏最多 1 个 primary + 2 个 secondary；其余操作进入“更多 ⋯”。

操作区放影响整页的动作，例如立即同步、重新抓取、导出、打开设置类 Drawer、查看图表 Drawer、复制 agent 指令。单行操作放在表格行或 Drawer；筛选和列设置留在表格工具栏。

| 页面 | 主按钮 | 次按钮 | 更多 ⋯ |
|---|---|---|---|
| 概览 | 立即同步 | 打开项目文件夹 | 校验本地数据文件、复制 agent 接入指令、打开 README |
| 库存 | 趋势与分类在线率（Drawer） | 导出 CSV | SKU 父子规则设置 |
| 产品 | 导出 CSV | — | SKU 父子规则设置 |
| SEO | 规则设置（Drawer） | 重新检查收录、导出 | — |
| 内容 | 重新抓取博客 | 博客识别设置；最近识别日期显示为状态标签 | 导出 |
| EDM | 生成命令 | 导出 | — |
| 设计 | 重新抓取设计规范 | 复制 Token（JSON） | 导出 design.md |
| README | 刷新 README | 编辑 | — |
| 运行 | 立即运行（选 job） | — | 打开日志目录 |
| 设置各子页 | 保存 | — | — |

## 4. 路由与画板对照

| 画板 | 路由 | 页面 |
|---|---|---|
| Main | / | 项目中心 |
| NewProjectUrl / NewProject / NewProjectBrand / NewProjectDone | /new/url、/new/source、/new/brand、/new/done | 新建向导 4 步 |
| Overview | /p/:id | 概览 |
| Inventory | /p/:id/inventory | 库存 |
| Products | /p/:id/products | 产品 |
| SEO | /p/:id/seo | SEO |
| Content | /p/:id/content | 内容 |
| Edm | /p/:id/edm | EDM |
| Design | /p/:id/design | 设计规范 |
| Readme | /p/:id/readme | README |
| Runs | /p/:id/runs | 运行与定时任务 |
| ProjectSettings / Categories / Folders / LocalFiles | /p/:id/settings/config、…/categories、…/folders、…/files | 项目设置四个子页 |
| Skills | /skills | Skill 中心 |
| AppSettings | /settings | 软件设置 |

## 5. 交互规则

- 所有列表支持搜索（200ms 防抖）和可组合筛选；显示当前条数与总数。
- 点击数据行打开 Drawer，Esc 关闭；关闭后焦点返回触发控件。
- 写操作成功或失败使用 Toast；持续性状态使用 Notice。不要在标题下方渲染临时成功/失败文案。
- 危险操作二次确认；空状态说明原因并给出下一步操作。
- 所有可点击元素使用 button 或 a；图标按钮有 aria-label；键盘可达；正文对比度不低于 4.5:1。
- 窗口宽度 1100–1280px 时侧栏可折叠为图标栏。