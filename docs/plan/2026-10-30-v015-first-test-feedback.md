# SiteIndex · v0.1.5 首轮实测六项缺陷与 v0.1.6 修复计划

> 2026-10-30（北京时间）。基于用户本人安装版反馈（6 项）和 `main` `2c328e4bbe0edf409ac318f64b05c30305e99f0f` 代码只读核查。本文件是执行计划，不代表这些问题已经修复或实机回归通过。原始截图含真实业务数据与 Feed URL，不上传公开仓库；Issue 仅保留脱敏文字。

## 1. 版本与范围

- 已发布 `v0.1.5` tag：`1ce628cc4b6edca51914c8dc5b853abd3eeb0f4c`。它早于 #200、#202、#203 合入 `main`，这些后续合并**不能**当作 v0.1.5 安装版已包含。
- 当前开发基线 main：`2c328e4`。#201（D4 关注分类界面）仍待处理重基线后的合并，#204（A0b 历史范围 shared 契约）刚开 PR、未合并。
- 用户选择**先发安装包，再本人实测并集中反馈**；#196 的隔离缺陷仍 OPEN，但不阻断个人快速验证版。不得把“编译通过”算作“安装版通过”。
- 本轮优先修复已能复现的可用性/数据完整性缺陷，**不改变既有 A/B/C/D/E 目录所有权或 contract 工作流**。

## 2. 反馈与责任矩阵

| Issue | 优先级 | 主责 | 根因 / 核查假设 | 本轮交付边界 |
|---|---|---|---|---|
| [#205](https://github.com/henryliuwork/SiteIndex/issues/205) 页面间距与布局回归 | P1（若遮挡则 P0） | B 全局、D 业务页 | 安装版全局/局部 CSS、容器间距或优先级不一致；需通过 computed style 证据定位 | 共享 token 与页面局部间距一致；多窗口/缩放无横向溢出 |
| [#208](https://github.com/henryliuwork/SiteIndex/issues/208) 库存趋势单日及图例溢出 | P1 | D（数据依赖 A/C） | 所有 `series` 同时画线并插入固定高度的 Legend；历史受已有业务日期与 Desktop 30 天调用限制 | 默认少量曲线、可选分类、图例不遮挡；0/1/多日明确区分 |
| [#207](https://github.com/henryliuwork/SiteIndex/issues/207) SEO 表格跨列 | **P0** | D，需要时向 B 提共享 Table 变更 | `.si-seo-url max-width:320px` 与 220px URL 列、fixed table layout 可能冲突；另核对虚拟行高 | URL 截断在本列；问题双行正常显示；滚动不重叠 |
| [#209](https://github.com/henryliuwork/SiteIndex/issues/209) 项目设置目录点击报错 | **P0** | D | `href="#source"` 等覆盖 React `HashRouter` 使用的 URL fragment | 保留单一配置页，程序化区块滚动，不破坏 `#/p/:id/settings/config` 或未保存草稿 |
| [#210](https://github.com/henryliuwork/SiteIndex/issues/210) Feed 已配置仍提示缺失 | **P0** | B（缺摘要字段时 A/C 协作） | `ProjectCenterPage` 在任何 warning 上都无条件显示“填写 feed” | 仅明确缺 Feed 才显示此 CTA；其他 warning 用匹配动作；保存后摘要刷新 |
| [#206](https://github.com/henryliuwork/SiteIndex/issues/206) 新建重复站点 | **P0（数据完整性）** | B UI + A Core + C 注册表 | 向导 detect 后无已登记站点查重；Core/registry 兜底需确认 | UI 禁止进入下一步，create 入口权威拒绝重复且不覆盖目录 |

### 2.1 已从代码确认的两个直接问题

1. `ProjectSettingsConfigPage.tsx` 使用 `<a href={'#' + target}>`，而 `App.tsx` 使用 `HashRouter`。**决策：不拆十个新路由**，现有“配置/分类/本地文件”仍为独立路由；配置页内部使用 button + `scrollIntoView` 和 `scroll-margin`。如需可分享的分区地址，使用 React Router 的 search 参数，而不是第二个 hash。
2. `ProjectCenterPage.tsx` 的任何 warning 都显示“填写 feed”；即便 warning 来自同步 partial/过期/失败，也会误导。必须先查可靠 Feed 配置状态，不允许凭 warning 文案猜状态。

### 2.2 不能误判为代码缺陷的历史曲线

- `trend.dates` 是**真实业务日期**，同一天多次同步不是多个日期；只有 1 个有效日期时无法绘制真实趋势线。
- `A-5a #202` 已合并，Core 内部可按真实日期选 `14/30/60/90/all`；`A0b #204` 正申请扩展 shared；之后仍需 C Desktop 透传和 D 页面开启真实范围。
- UI 先解决图例挤出、分类过多和 0/1 天空状态。后续每日跑 daily，至少形成两天**真实不同业务日期**后方可验证线；禁止复制点、随机插值、假装历史或把 30 天标签等同有 30 天数据。
- 分类曲线默认建议最多 3 条（优先 watched），用户可搜索/勾选，建议上限 5 条；图例位于绘图区外的可折叠区域，不能覆盖数据表。

## 3. 五工作流本轮任务

### A · Core（P0 数据保护 + 既有主线）

- #206 核对 `projects.create` 是否在文件创建前检查**同一 canonical 站点已经登记**，覆盖大小写、scheme、www、尾斜杠及常见 redirect；需与 C 的扫描/注册表来源对齐。不可覆盖、改名或删除已有项目。并发创建要有二次校验与结构化错误。
- #210 如 ProjectSummary 没有可靠 Feed 配置位，则从持久化配置确定状态，先讨论 shared 可选字段的独立契约 PR；不使 #204 与另一 contract PR 同时开放。
- 延续 A0b #204 → A-5b → A-6 真实价格事件 → A-7 SEO rule/计数；各项独立 PR。#166 与 #165 仍是 v0.2.0 功能缺口。

### B · 全局/应用页

- #205 审计 Electron 打包样式与全局 token、共享容器；不动 D 项目页源码。
- #210 给项目中心警告加语义门控：Feed 配置正常时不显示“填写 feed”；其他警告显示原因与正确动作。保存后列表、详情缓存一致。
- #206 向导输入/检测后做项目列表查重；同站点不允许下一步，提供“打开已有项目”；最终 Create 仍需后端兜底，不能只用前端防重。
- 与 D 协调共享 Table/样式的真正跨页改动，先并行查因，避免跨目录 PR。

### C · Desktop/发布

- #206 检查 `projects.list` 扫描 `projects_root + extra_projects` 的去重覆盖，以及 Desktop/IPC create 入口的竞态与错误传播；如果 A Core 的入口无法获知注册表，需要提供可信扫描能力，不自行改 shared。
- #210 追踪配置保存后项目中心 `projects.list` 是否仍读缓存旧状态；如有 Desktop 侧原因单独修复。
- A0b 合并后单独让真实 IPC 接受 60/90/all；验证构建与 Core 一致。不为追这个契约阻挡 v0.1.6 视觉/防重修复。
- 修复 PR 全合并、CI 绿后从固定 main commit 发 `v0.1.6`，Release Notes 标注“个人测试版”；Windows EXE、macOS DMG、更新 metadata 与 hash 齐全。新包不要复用 `v0.1.5` tag。

### D · 项目业务页

- #209 最优先修复配置页左侧导航：保持配置页单页内部滚动，键盘可操作、不丢草稿、不误跳路由。
- #207 第二优先修 SEO URL/问题跨列、表格虚拟滚动行高。
- #208 默认分类曲线缩减、可选图例、0/1 天说明。默认展示稳定并支持用户手动启用更多分类；不伪造缺失历史。
- #205 配合审计 Overview/Inventory/SEO/配置页各自的页面级 `page.css`；B 负责全局。
- **先解决 #201 旧分支与 #200/#203 的冲突并合并**，之后再从最新 main 拆独立 PR，避免覆盖已合并的 SKU 预览/初始化 mock。

### E · 用户反馈与验收

- 以**安装版实际 tag/commit**登记每条修复是否存在；不能把新 main 上的代码当成旧安装包。
- Henry 本人验收 v0.1.6 六项，E 根据文字/脱敏截图整理逐项通过/失败/未测，并将失败复现步骤转 Issue。
- 全仓 typecheck/test/三系统 CI 是 PR 门槛，不等于安装版验收；#196 保持 OPEN，非本次个人测试的前置阻断。

## 4. 交付顺序与 Roadmap（北京时间）

| 阶段 | 目标窗口 | 完成定义 |
|---|---|---|
| F0 缺陷取证/任务分配 | **10/30–10/31** | 六个 Issue；B/D 确认 CSS 与组件边界，A/C 确认查重和 Feed 状态来源；冻结 v0.1.6 的修复范围 |
| F1 修 P0 | **10/31–11/02**（争取） | #209 设置点击不再报错；#207 表格无重叠；#210 Feed CTA 准确；#206 双层查重，均有回归测试 |
| F2 视觉/图表 | **11/01–11/03**（并行） | #205 布局审计与调整；#208 图例数量/折叠/单日提示；无假造历史。B/D 各自独立 PR |
| **F3 v0.1.6 个人修复版** | **争取 11/03–11/05** | 上述 P0 + 视觉修复合并、三系统 CI 绿；C 打包发布；Henry 安装并反馈。窗口是目标，不是已承诺发布日期 |
| G2 功能链收敛 | **11/04–11/10 滚动** | #204/A-5b → C/D 历史范围；A-6 价格事件、A-7 SEO 规则与 D 真实数据接线；继续修 #92/#93/#100/#196 |
| G3 v0.2.0-rc | **争取 11/10–11/13** | 功能 PR 代码收敛，固定 commit，生成候选安装包；E/用户核对真实数据与回归矩阵 |
| G4 v0.2.0 | **暂维持 11/13–11/18 目标** | P0 功能、真实 IPC、数据链与安装版验收通过才发布；未满足则顺延并继续发小版本修复 |

### v0.1.6 最低放行标准

- #206 的后端权威查重**必须**通过，不得因 UI 已拦截就省略。
- #209 左侧十个设置分区点击后不触发 HashRouter 404；配置草稿保存/取消行为稳定。
- #207 SEO 表格不同数据长度/125% 缩放不会跨列重叠。
- #210 已配置 Feed 且同步 partial/failed 时不误提示 Feed 缺失。
- #208 在只有单个真实日期时明确提示，不画假线；多分类图例不会侵占整个绘图区。
- #205 宽窄窗体的核心功能无明显间距/布局回归。
- 所有合并 PR 的 Windows/macOS/Ubuntu CI 全绿；用户安装版反馈另行记载，不提前关闭历史 Issue。

## 5. 交叉工作流纪律

- B 共享样式/ProjectCenter/NewProjectWizard，D 业务项目页，A Core，C Desktop；共享类型只允许单独 `contract/*` PR，同一时刻最多 1 个开放。
- 独立 PR 建议 ≤600 行、每个 PR 基于最新 main，三系统 CI 绿，由审核者 merge commit 合并；不得将视觉修复和 Core 历史改动混在一个 PR。
- 不上传用户原始截图、Feed URL、SKU、价格、业务路径到公开仓库；回归只用虚构数据与脱敏截图。
