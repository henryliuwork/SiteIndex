# SiteIndex · 界面设计规范 v2

界面结构与文案以 design/demo/*.dc.html 画板为参考，数据与交互行为遵循当前 PRD 和 API 契约。v0.6 起，全局字号、间距、基础组件、页面操作区与表格遵循本规范；新增页面不得自创基础视觉值。

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

正文与标题按 `--font-sans` 使用 Geist Variable（英文、数字）及 Source Han Sans SC（中文）；SKU、URL、路径等标识符使用 Geist Mono Variable。Noto Sans SC variable 以 SIL OFL-1.1 发布包随 UI 打包，并以 `Source Han Sans SC` CSS family 名称提供；这是思源黑体同设计的离线字体，不依赖网络或用户系统安装。保留 Microsoft YaHei UI、PingFang SC 作为后备字体。

```css
--font-sans: "Geist Variable", "Source Han Sans SC", "Microsoft YaHei UI", "PingFang SC", sans-serif;
--font-mono: "Geist Mono Variable", Consolas, monospace;
```

| token | 字号 / 行高 | 字重 | 用途 |
|---|---:|---:|---|
| --fs-page-title | 20px / 28px | 600 | 页面标题、项目名 |
| --fs-section-title | 14px / 20px | 600 | 卡片与区块标题 |
| --fs-sub-title | 13px / 20px | 600 | 子区块、抽屉分组标题 |
| --fs-body | 12px / 18px | 400 | 默认正文、表格单元格、按钮、输入框 |
| --fs-caption | 11px / 16px | 400 | 辅助说明、表头小字、徽标 |
| --fs-micro | 10px / 14px | 400 | 仅说明性文字；全站字号下限 |
| --fs-kpi | 24px / 30px | 600 | 指标数字 |
| --fs-mono | 12px / 18px | 400 | 等宽内容 |

表头使用 12px、字重 600、muted 色；文字对比度不低于 4.5:1。任何文字不得小于 10px。页面 CSS 不得新增裸字号；确需新层级时先扩展 token。

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

页面内边距使用 `--space-page-padding`（`--space-6`）；区块间距使用 `--space-section`、卡片内边距使用 `--space-card-padding`（两者均为 `--space-4`）；表单项间距使用 `--space-form-item`（`--space-3`）；输入框与按钮、按钮组及相邻控件使用 `--space-control-group`（`--space-2`）；表头与内容的紧邻间距使用 `--space-table-header-content`（`--space-2`）。新 CSS 的 margin / padding / gap 不写裸 px；允许 `0`，边框允许 1px。

### 1.4 控件、组合输入、Tab 与时间

- 按钮、输入框、下拉、复选框统一使用 `--control-height: 32px`；紧凑场景使用 `--control-height-compact: 28px`。同一行的控件垂直居中，不能由按钮文案或图标改变行高。
- “输入框 + 操作按钮”使用共享 `InputWithAction`：输入框与操作按钮同高、垂直居中，间距为 `--input-with-action-gap`；页面不得各自手写 flex 组合。通过 `children` 传入输入控件，通过 `action` 传入一个或多个操作按钮：

  ```tsx
  <InputWithAction action={<Button type="submit" variant="primary">检测</Button>}>
    <Input aria-label="网站地址" value={url} onChange={(event) => setUrl(event.target.value)} />
  </InputWithAction>
  ```
- Tab 只有两种：**项目导航 Tab** 改变路由，在 ProjectHeader 中使用，待办也是项目导航 Tab；当前项使用主色文字和底部指示线。**页内分段 Tab** 只切换当前页内容，不改变路由；选中项使用实底突出。不得新增第三层 Tab。窄窗口下项目导航 Tab 与页头操作区均自动测量溢出并收纳到“更多 ⋯”，**禁止出现横向滚动条**，当前项和键盘焦点保持可见。
- **界面文案精简原则**：`Avoid unnecessary secondary labels and descriptions. Let the layout do the explaining.` 页面不写多余的副标题、解释段或重复提示；必须说明的规则或术语统一放在共享 `<InfoTooltip>`（圆形 `i` 图标按钮，hover/focus 触发短句气泡，宽度 ≤ 240px）。
- 时间统一通过共享 `formatDateTime` 展示：同年为 `MM-DD HH:mm`，跨年带年份；禁止“今天 / 昨天”等相对前缀。项目头只显示一次最近同步时间；不同数据源的时间说明放进 `InfoTooltip`。板块页可见的表格时间同样受 §3.2 的单处时间限制。
- `ui:check` 对裸字号、裸色值、裸 px 间距和小于 10px 的字号执行失败检查。已有 D 页面遗留问题记录在 `packages/ui/visual/style-baseline.json`；命令会报告基线数量，新违规立即失败，页面迁移时逐步降低基线。页面日期/时间超过一处时产生人工复核告警。

## 2. 基础组件

B 维护 packages/ui/src/components/ 中的共享组件。页面组合这些组件，不复制基础交互与状态样式。

| 组件 | 规范 |
|---|---|
| Button | 高 32px，小号 28px；primary / secondary / ghost / danger。每个操作区最多一个 primary；图标按钮必须有 aria-label 和 tooltip。 |
| Input / Select / Checkbox | 控件高 32px，聚焦环统一。Select 使用 Radix Select/Popover，不用原生 select。 |
| InputWithAction | 输入框与同行操作按钮共用高度、垂直居中与 `--input-with-action-gap`；作为共享组件使用。 |
| InfoTooltip | 圆形 `i` 图标按钮（基于 `@radix-ui/react-tooltip`），hover/focus 弹出单句说明（≤ 240px）；禁止用大段内联说明文字替代。 |
| Tabs | 只允许项目导航 Tab（路由切换）与页内分段 Tab（内容切换）两种；不得新增第三层。 |
| FilterBar | 筛选下拉优先于 pill；内容超过两行时可折叠，最多两行时不显示“更多筛选”。 |
| Chip | ok / warn / danger / info / neutral；字号使用 --fs-caption、字重 600。处理状态等状态列统一使用 Chip。 |
| Card / KpiCard | 卡片圆角 8px、内边距 16px；标题使用 --fs-section-title；KPI 数字使用 --fs-kpi。可点击卡片提供 hover 和 focus 状态。 |
| Drawer | 右侧滑出，标准宽 480px，宽内容 720px；标题和关闭按钮固定，内容区独立滚动；支持 Esc、焦点陷阱和关闭后焦点返回。行详情、规则设置、趋势与配置类面板使用 Drawer。 |
| Toast | 由 ToastProvider 提供全局右上角堆叠，并通过 useToast 调用。成功 3 秒后消失；错误需用户手动关闭。写操作结果通过 Toast 呈现，不在标题下方保留临时状态文案。 |
| Notice | 内容区顶部的持续性横幅，支持 info / warn / error、图标和可选操作。用于需用户持续处理的状态。 |
| EmptyState | 显示图标、空状态原因和下一步操作按钮。 |
| PageHeader | 统一提供 title、meta、actions 和 overflow；应用级页面使用。五个板块页将操作并入 ProjectHeader，按 §3 的骨架排列。 |
| SummaryLine | 一行最多四个可点击的行动/变化数字；点击切换下方表格筛选，窄窗自动收纳到“更多”；独立来源时间只放末尾 InfoTooltip。 |
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

项目导航与操作统一放入 `ProjectHeader`。页面操作栏最多 1 个 primary + 2 个 secondary；其余操作进入“更多 ⋯”。SEO、内容、EDM、产品管理、概览五个板块页按 §3.2 的 v0.7.5 骨架迁移；下表记录其余项目页及迁移前的动作归属，不覆盖 §3.2。

操作区放影响整页的动作，例如立即同步、重新抓取、导出、打开设置类 Drawer、查看图表 Drawer、复制 agent 指令。单行操作放在表格行或 Drawer；筛选和列设置留在表格工具栏。

| 页面 | 主按钮 | 次按钮 | 更多 ⋯ |
|---|---|---|---|
| 概览 | 立即同步 | 打开项目文件夹 | 校验本地数据文件、复制 agent 接入指令、打开 README |
| 产品管理 | 立即同步 | 趋势与分类在线率（Drawer）、导出 CSV | 查看今日日报、标签管理、SKU 父子规则预览与设置 |
| SEO | 规则设置（Drawer） | 重新检查收录、导出 | 重新抓取 SEO 数据 |
| 内容 | 重新抓取博客 | 博客识别设置；最近识别日期显示为状态标签 | 导出 |
| EDM | 生成命令 | 导出 | — |
| 设计 | 重新抓取设计规范 | 复制 Token（JSON） | 导出 design.md |
| README | 刷新 README | 编辑 | — |
| 运行 | 立即运行（选 job） | — | 打开日志目录 |
| 设置各子页 | 保存 | — | — |

### 3.1 表格顶部工具栏规范（方案 A）

所有带表格的业务页统一采用固定两层结构，禁止把整页动作或筛选操作混排混乱：

1. **视角切换行（如有）**：仅不同实体允许页内分段 Tab `Segmented`，单独前置左对齐（如内容的博客/关键词），不与筛选条或搜索框硬挤一行。SEO 的问题/页面/内链须合并，见 §3.2。
2. **工具栏（左 / 右严格分区）**：
   - **左侧**：`SearchInput` + `FilterBar` 筛选控件（超过两行可折叠）；
   - **右侧**：展示模式切换（如仅父 SKU / 显示子 SKU）、列设置（如适用）、结果统计（`显示 a / b 条`）；
   - **禁止混入**：`运行`、`立即同步`、`导出`、`规则设置` 等整页级动作**全部留在右上角页头**，不进表格工具栏；筛选条内不放业务动作按钮；
   - **批量选择**：仅当用户勾选表格行时，才在工具栏位置浮出或叠加批量操作条（标记已处理、忽略等），未勾选时不占位。

### 3.2 五个板块页规范（v0.7.5）

适用于 SEO、内容、EDM、产品管理、概览。自上而下固定为：

1. `ProjectHeader`：项目名、域名、唯一的“最近同步”时间、项目导航与页头操作。
2. 可选的共享 `SummaryLine`：单行最多四项，仅放需要行动或发生变化的数字；每项由标签、数字和可切换表格筛选的按钮组成。点击应用筛选，再点取消。相同数字不得在导航徽标或表格上方重复，工具栏的总数计数除外。窄窗自动收纳到“更多 ⋯”，不换行、不横向滚动。
3. 工具栏：左为搜索和筛选，右为视图开关、列设置和结果计数；批量操作仅在选中行后出现。
4. 主表格使用 DataTable v2；行抽屉承载详情、问题、内链及变化。条件横幅仅在任务进行中、失败或需要处理时出现，其他时候不占位。

`SummaryLine` 由页面持有筛选状态，数字和筛选要来自同一查询口径：

```tsx
<SummaryLine items={[{
  id: "open", label: "待处理", value: openCount,
  active: status === "open", onToggle: () => setStatus(status === "open" ? undefined : "open"),
}]} timeNote={`SEO 抓取于 ${formatDateTime(crawledAt)}`} />
```

**时间**：页面内不直接重复展示数据时间。若板块数据与项目“最近同步”的来源时间不同，仅在摘要末尾使用 `InfoTooltip`，例如“SEO 抓取于 11-08 17:00”。同页可见的 `formatDateTime` 形态时间最多一处，位于项目头；表格可见文本也计入，禁止“今天 / 昨天”。

**分段**：同一实体的不同属性合并为列和行抽屉分段，不能拆成多个页内 Tab；不同实体才允许一组页内 `Segmented`（例如博客文章和关键词映射），且无计数徽标。切换页内分段不得清空另一分段的筛选与列状态，也不得在表格内部联动重置。抽屉内的分段允许。概览页可保留最多六张指标卡，每张必须跳转到对应板块的已筛选视图；卡片数字和文案不得与项目头重复。

**可量化验收**（`pnpm ui:check`）：1280×800 且没有条件横幅时，表头顶边 ≤ 200px；首屏 52px 行的可见容量 ≥ 9 行；同页可见时间 ≤ 1 处；抽屉外页内分段 ≤ 1 组、无计数徽标；“今天 / 昨天”可见文本为零；1024×768 至 1920×1080 无横向滚动条。W0 的五页测量记入 `visual/section-page-baseline.json`；迁移时删除该页基线，新增或加重违规立即失败。阈值仅可在 W0 实测后按路线图调整。

**各页落地**：SEO 主体为页面表（标题/URL、页面类型、收录状态、待处理问题数与严重度、内链入出、最近变化），按高优先级待处理数与本次新增排序；问题、内链、收录进入行抽屉，批量处理需确认条数。内容的博客识别、时间和 KPI 收入摘要，博客/关键词两实体可分段。EDM 的任务提示变成条件横幅，导出进入页头。产品管理的 KPI 收成在线率、今日变化、长期缺货、状态波动摘要，保留单表及抽屉。概览遵守上述卡片规则。页面迁移前由 D 提交“重复 / 独有 / 删除”的合并矩阵。

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

## 6. v0.8.0 页面外框、导航与表格规范

本节同步 [v0.8.0 路线图 §3](plan/2026-11-20-v080-ui-frame-spec-roadmap.md) 的规范正文；旧版页面规范在迁移期间仅作历史参考。

### 6.1 页面外框 `PageFrame`
所有页面只允许两种外框，由 B 提供共享组件，页面不得自行设置顶部距离、`calc(100vh - …)` 或负 margin。

| | 全局页（项目中心、Skill 中心、定时任务、设置、新建项目向导） | 项目页（项目内全部页面：概览、待办、产品管理、SEO、内容、EDM、设计、README、运行、设置各子页） |
|---|---|---|
| 顶部 | 页面标题行：高 56px；上内边距 `--space-6`（24px）；**不吸顶** | **项目头紧贴标题栏下沿，上内边距 0；吸顶（sticky）** |
| 顶部内容 | 标题（`--fs-page-title`）、可选标题旁 `InfoTooltip`、右侧页面操作 | 项目导航 Tab（左）+ 页头操作（右），**单行，高 48px** |
| 项目标识 | — | **不在页头出现**，见 §6.2 |
| 页面内容起点 | 标题行下 `--space-4`（16px） | 项目头下 `--space-4`（16px） |
| 水平内边距 | `--space-6` | `--space-6` |

**滚动规则（所有页面唯一）**：
1. 含 DataTable 的页面：窗口、内容区**都不滚动**，只有表格体内部滚动；页面滚动条出现即为缺陷。
2. 不含表格的页面（README、设计、设置、运行等）：项目头吸顶不动，**只有项目头下方的内容区滚动**。
3. 同一页面只允许一个纵向滚动容器。

### 6.2 项目标识迁入侧栏
- 项目页头**删除**"项目名 · 域名 · 平台 · 最近运行 · 状态 chip"整行。
- 侧栏项目项改为两行：
  - 第一行：项目名（`--fs-body`，600 字重，单行省略）。
  - 第二行（浅灰、`--fs-caption`，单行省略）：`平台 | MM-DD HH:mm`。示例：`Magento 2 | 11-20 13:39`。平台显示名取自项目数据 `platform` 经共享映射得到，**映射里没有的平台原样显示，不得臆造版本号**；运行时间使用共享 `formatDateTime`，无记录显示"未运行"。
  - 域名不再显示在页面上，放在侧栏项目项的 `title`（悬停）与项目设置页。
  - 原项目头里的"存储位置警告"迁为侧栏项目项右侧的警告图标（悬停说明），并在概览页保留一条 `Notice`；原 `projectStatus` chip（如"SEO 页面：414 个""设计规范已提取"）取消，其中有行动价值的信息并入对应页面的 `SummaryLine`，其余删除。
- 数据均已在 `ProjectSummary`（`platform`、`sync.at`）中，**无需契约变更**；只扩展 `SideNavProject` 这一 UI 类型。

### 6.3 项目页头：导航与操作区
| 项 | 规范 |
|---|---|
| 行高 | `--project-header-height`: 48px；底部 1px 分隔线 |
| 导航 Tab | 字号 `--fs-sub-title`（13px）；左右内边距 `--space-3`（12px）；Tab 间距 `--space-1`；当前项主色 + 2px 底部指示线；窄窗口收纳到"更多 ⋯"（沿用 v0.6.1，不得横向滚动） |
| 页头按钮 | 高度 `--control-height`（**32px**，不再用 28px small）；左右内边距 `--space-3`；图标 16px，图标与文字间距 `--space-2`；字号 12px |
| 按钮间距 | `--space-3`（**12px**） |
| 按钮数量 | ≤1 主 + ≤2 次 + "更多 ⋯"（沿用 v0.6.0） |
| 与 Tab 的最小间距 | `--space-4`；不足时按钮先收纳进"更多" |

### 6.4 表格上方的纵向节奏与控件
自上而下四个区域，**区域之间统一 `--space-section-gap`（12px）**，不得靠各页私有 margin 调整：
1. `SummaryLine`（可选，单行）
2. 已选筛选标签行（**仅有筛选时出现**；标签高 28px，标签间距 `--space-2`；该行上下各留 12px，因此出现与消失时不让上下元素贴住）
3. 工具栏：左 搜索（宽 280px）+ 筛选；右 视图开关 + 列设置 + 结果计数。**所有控件高 `--control-height`（32px），控件间距 `--space-2`（8px）**，工具栏行高 32px；筛选超过一行时折叠
4. 表格

### 6.5 表格列标准
1. **列序（自左至右）**：选择框 → **标识列** → 名称/标题列 → 状态类列 → 度量类列 → 时间类列 → 右侧固定操作列。
2. **标识列**：有 SKU 的表格，**SKU 单独成列放在最前（选择框之后）**，等宽字体（`--font-mono`），宽 120–160px，单行不换行，**左侧固定（sticky left）**；其后单独一列"产品名称"（含缩略图）。父子 SKU 视图中父行显示父 SKU，子行缩进显示子 SKU。SEO 表的标识列为"页面"（标题 + URL 两行）。
3. **对齐**：文本左对齐；数字、价格、百分比**右对齐**并使用等宽数字（`font-variant-numeric: tabular-nums`）；表头对齐方式与列内容一致。
4. **宽度**：沿用 DataTable 列宽契约（`width / grow / minWidth`）；任何单列默认宽度不超过表格宽度的 40%；时间列统一 140px。
5. **列设置**：次要列默认可隐藏；标识列与操作列不可隐藏。

### 6.6 其他控件
- **InfoTooltip**：气泡 `max-width: min(240px, 可用宽度)`；`overflow-wrap: anywhere`、`word-break: break-word`；使用 Radix 的碰撞避让（`collisionPadding` ≥ 8px）；路径、URL 等长串必须在气泡内折行，不得溢出。
- **设计页**：主要颜色角色卡**同时显示 HEX 与 RGB**，提供"复制 HEX""复制 RGB"两个按钮（已复制状态沿用现有反馈）；按钮规范区中"未识别"的变体收为**一行**"未识别此按钮变体"，不再占整块高度。
- **对话框、抽屉**：不在本版改动。

### 6.7 `ui:check` 新增断言（违反即失败）
| 断言 | 阈值 |
|---|---|
| 项目页：项目头顶边距视口内容区顶边 | 0px（±1） |
| 项目页：项目头高度 | 48px（±1） |
| 项目页：页头按钮高度 | 32px（±1）；相邻间距 12px（±1） |
| 项目页：各页面内容起点距项目头底边 | 16px（±1），**所有项目页一致** |
| 全局页：标题行高度与上内边距 | 56px / 24px（±1），所有全局页一致 |
| 含 DataTable 的页面：`document` 与内容区纵向滚动 | 不出现 |
| 工具栏：搜索框、筛选按钮高度；相邻间距 | 32px；8px（±1） |
| 筛选标签行存在时：与上下相邻区域的间距 | ≥ 12px（±1） |
| 带 SKU 的表格：首个数据列表头文字 | "SKU" |
| InfoTooltip：气泡内文字不超出气泡边界 | 对页面内所有 tooltip 触发后检测 |
| 项目页头内不出现域名文本 | 0 |
