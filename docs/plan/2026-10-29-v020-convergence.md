# SiteIndex · v0.2.0 收敛开发与真实项目验收计划

> 制定：2026-10-29 · 协调文档（A / B / C / D / E 共用）  
> 基线：`main` = `e5e89a5205581a7bddb24b20f4d9b18a4536400a`；最近发布版 `v0.1.4`  
> 依据：`AGENTS.md`、`docs/WORKSTREAMS.md`、`docs/plan/2026-10-29-feedback-v2.md`、`docs/tasks/{A-core,B-ui,C-desktop}.md`  
> 本文为下一轮执行顺序与验收关卡，不覆盖 `DATA_SPEC.md` 的数据契约，也不授权跨工作流修改。

## 0. 当前事实与边界

- `main` 已合并：Feedback v2 类型字段、IPC 方法清单迁移、博客识别、关注分类摘要标记、项目配置界面、运行页重做、Geist 字体、抽屉 560px、README 默认只读、软件设置分区、项目标题吸顶、移除写死的“示例数据”。
- PR [#159](https://github.com/henryliuwork/SiteIndex/pull/159)（SEO、库存筛选/趋势/父 SKU 界面）**尚未合并**；其最新 head `a2524388` 三系统 CI 已成功。先由审核者检查最新 diff 与既有 Review，再合并；D 不在同一组页面叠加新 PR。
- `v0.1.4` 是最近公开 Release。Issues [#163–#174](https://github.com/henryliuwork/SiteIndex/issues) 是针对该安装包的验收记录，**不能直接认定为当前 main 仍然存在，也不能仅凭 main 代码改了就关闭**；须用候选安装包回归。
- A 任务清单仍未勾选：A-2、A-4、A-5、A-6、A-7、A-9；A-3（博客识别）与 A-8（趋势仅一天数据）已完成。以代码与测试取证核实，不机械相信复选框。
- 当前共享契约中，`SiteConfig.sku_grouping`、`SkuStockView.parent_sku/price_history`、`SeoSummary.issue_counts`、`SkuStockFilters.price_changed_within/parent_only/watched_only` 已存在；但 `sku.previewGrouping` 未声明，`inventory.summary` 仍是 `14 | 30`，`seo.checkIndex` 与 `index-check` Job 仍存在。避免重复添加已有字段。
- 业务边界不变：SiteIndex 负责 `index/` 数据、README 与 Skill 分发，不管理用户工作成果目录；不引入 GSC、账号/云端服务或 AI 内容生成到本轮 MVP。

## 1. 不可违反的协作规则

1. 五个独立 Agent 对话分别执行 A（Core）、B（UI 共享层）、C（Desktop）、D（UI 项目页面）、E（验收）。开始前读 `AGENTS.md`、`docs/WORKSTREAMS.md`、本计划；A/B/C 再读各自原任务清单。
2. 只改自己拥有的路径。B 不改 D 的项目页面；D 不改共享组件、`App.tsx`、全局 token；A 不改 Desktop；C 不改 Core。跨边界时创建带 `ws:A/B/C/D` 标记的 Issue。
3. `packages/shared/` 只允许独立 `contract/*` PR；同时最多一个未合并契约 PR。优先新增可选字段。破坏性 API/Job 删除必须列出 A/B/C/D 迁移影响，待使用方就绪再执行。
4. 每个实现 PR 基于当时最新 `main`，不要堆在未合并 PR 上；建议改动 ≤600 行。不可直接 push `main`、不可自合并。审核者合并前核验 Windows/macOS/Ubuntu 三系统 CI。
5. 仓库公开：不能提交真实 GMC Feed、真实客户/订单数据、token、Webhook、内部路径/敏感日志。测试只使用虚构 fixture；E 提交 Issue 要脱敏 SKU、价格、域名和路径等业务数据。
6. 接口、`schemas/`、`DATA_SPEC.md`、黄金测试必须一致。失败/partial 不可被 UI 展示成成功；不能用 mock 测试代替 Electron 真实 IPC 验收。

## 2. 合并关卡与执行顺序

| 关卡 | 前置条件 | 放行后可启动 | 不通过时的处理 |
|---|---|---|---|
| G0 · 当前 PR 收尾 | 审核者确认 #159 最新 diff、冲突已处理、三系统 CI 绿并合并 | D 的后续项目页面联调 | D 保持只读审查或做不重叠页面，不再改 Inventory/Seo |
| G1 · 兼容契约新增 | A 先用独立 `contract/*` PR 以可选方法/命名空间引入 `sku.previewGrouping`、方法清单与 `PENDING_HANDLERS`；待消费者支持后再单独扩大库存历史范围参数；每次三系统 CI 全绿 | A-2、C IPC、D 预览对接；A-5 的新范围需第二次契约关卡 | 不得一次引入必需命名空间导致 UI mock / Desktop bridge 失配 |
| G2 · Core 能力 | A-2/4/5/6/7 分批实现，schema、fixtures、单测/黄金测试一致；三系统 CI 绿 | D 从 mock/兼容 fallback 转真实行为，C 完成所有新 handler | 若 Core 返回不完整，不在 UI 伪造库存、价格与父 SKU 指标 |
| G3 · Desktop/页面联调 | C IPC 完整性测试通过、`PENDING_HANDLERS` 清零；D 所有新增操作有真实数据路径 | E 候选包完整验收 | 缺接口/不确定数据，开归属 Issue，保持发布阻断 |
| G4 · 发版 | E 的 Windows 真实项目、CLI 与 PRD §8 场景通过；三系统 CI/打包通过；阻断 Issue 已关闭或明确延期并获批准 | 协调者创建版本 PR、tag 与 Release | 未通过则继续候选版本，不急于打 `v0.2.0` |

> 顺序不是所有 Agent 等待：A 可先做独立 Core 单测，B 可先处理共享层问题，C 可先修 CLI 打包路径，E 可先整理 v0.1.4 基线；只有依赖合并被关卡限制。

## 3. A · Core / CLI（执行顺序）

**A0 契约 PR（最先发，分两次兼容迁移）**
- A0a：检查已有 types，避免重复声明。先定义 `sku.previewGrouping(id, rule)` 的父/子数量、样例与未匹配数；新 `sku` 命名空间或方法必须先设为**可选**，以保证尚未实现的 UI `createMockApi()` 与 Desktop `createApiBridge()` 仍能满足 `SiteIndexApi`。新方法同步维护 `API_INVOKE_METHODS` 与 `PENDING_HANDLERS`，按反馈计划 §8.2 流程；本 PR 不混入 Core/UI/Desktop 实现。
- A0b（A-5 能力与 D 的 mock 参数适配就绪后）：单独将 `inventory.summary` 范围扩大为 `14 | 30 | 60 | 90 | "all"`（旧 `14`/`30` 仍合法）。当前 `packages/ui/src/mock/context.ts` 的 `inventorySummary` 参数按 number 推断，直接扩大为含 `"all"` 的共享类型可能造成 CI 失败；先由 D 在其目录把 mock 改为兼容新参数，再提交契约 PR。若 Core/其他调用方未准备好，先保留旧签名，不绕过类型检查。
- 必要时另开契约 PR 扩充 SEO 规则。不得在新增契约 PR 中提前删除 `checkIndex`；C 实现后再按单独契约 PR 去除 pending。**同一时刻只有一个未合并契约 PR。**

**A1 数据与视图（拆为小 PR）**
- A-2：仅从 feed 子 SKU 按 suffix/separator/regex 规则推导父 SKU；提供预览、未匹配数、稳定排序。生成的父 SKU 不作为库存明细实体，也不单独计算在线率；规则关闭时保留现有子 SKU 行为。用 ≥3 种虚构规则与边界用例测：空值、异常 regex、同名冲突、单子项。
- A-4：关注分类读写、已抓取+手动分类合并去重；`inventory.summary.category_rates` 返回 watched/manual 标记。关注仅改变显示偏好，不改变 crawl、SKU 分类来源与分母。
- A-5：30/60/90/全部区间基于站点业务日期与真实历史天数，区间不满时不补零；返回 timezone/起始日期信息。旧 `14` 参数仍可用，单日数据仅显示一个业务日期。
- A-6：从实际 `inventory/events` 中的价格变动计算 `price_history`，支持价格变动时间筛选；不能由当前价伪造过去价格。没有可靠价格历史时返回空/未知并明确测试。
- A-7：补 SEO issue 规则和稳定 `rule` key，包括重定向链、Title/Description 缺失/长度/重复、canonical、schema、hreflang、URL 长度、图片 alt、孤立页等；对“未抓到”与“确认没有”严格区分。`DATA_SPEC.md`、schema、单测同步更新。

**A2 去除批量收录检查（最后做）**
- A-9：与 C/D 对齐后移除 `index-check` 后台 Job/CLI/共享契约的批量方法，保留单页 `seo.googleSiteUrl`。先给出影响清单，再以独立 PR 处理 API 破坏性变更；不删除用户既有索引结果字段。

**A 交付**：每个 PR 附修改文件、核心输入/输出、测试命令与结果、数据迁移影响；重点对照 [#165](https://github.com/henryliuwork/SiteIndex/issues/165)、[#166](https://github.com/henryliuwork/SiteIndex/issues/166)。

## 4. B · UI 共享层

**B1 可访问性与交互复核**
- 仅处理 `components/**`、`styles/{app,components,tokens}.css`、`App.tsx` 及 B 拥有的 Readme/AppSettings 页面。补 keyboard focus、按钮/弹窗 aria-label、Esc/焦点返回、颜色对比；已有行为不得回归。
- 使用最小窗口 1100×720、Windows 高 DPI 与中文长文本验证共享组件不遮挡；不能改 D 的 Seo/Inventory/Content/Runs/ProjectSettings 页面。发现页面级缺陷开 `ws:D` Issue。

**B2 性能/真实 IPC 合同检查**
- 从 [#88](https://github.com/henryliuwork/SiteIndex/issues/88)、[#93](https://github.com/henryliuwork/SiteIndex/issues/93)、[#82](https://github.com/henryliuwork/SiteIndex/issues/82) 核对缺口；给出 10,000 SKU 的可复现基准（首屏 <1s、交互 <200ms 的测量口径需注明硬件与 mock/真实环境）。
- B 只修共享层与基础渲染性能；Core 查询或 Desktop 冷启动问题分别转交 A/C。不得将 mock 通过视为真实 IPC 通过。

**B 交付**：1–2 个小 PR、共享组件检查表、性能数据与截图/录屏；如暂无可靠测量工具，写明限制，不编造结果。

## 5. C · Desktop / 打包

**C1 Windows CLI schema 路径（优先）**
- 先复现 [#163](https://github.com/henryliuwork/SiteIndex/issues/163)：安装版 `siteindex run ... daily/weekly/validate --json` 的 schema 查找指向 AppData，而实际资源在安装目录。定位 `resourcesPath`、CLI 启动脚本与 schema 参数传递；修复本工作流可拥有的 Desktop/打包代码。
- 若根因在 Core/CLI 的路径解析，提交最小复现 Issue 给 A，不越权改 Core。使用虚构 fixture 在 Windows 安装版同时验证 UI `--run-job` 和 CLI 路径、退出码、文件输出一致。

**C2 新契约与 IPC**
- G1 合并后实现 `sku.previewGrouping` 等新方法的 Desktop handler/转发；方法清单仍在 shared，按独立契约 PR 移除 `PENDING_HANDLERS`，完整性测试必须精确覆盖全部方法，无 orphan handler。
- 与 D 对齐项目配置保存、数据失效刷新、运行页 Job 状态、计划保存与权限回退；取消批量收录检查时清理 Desktop 接线，保留单页 URL 打开。

**C3 发布阻断项**
- 从 C 任务清单与 [#92](https://github.com/henryliuwork/SiteIndex/issues/92)、[#100](https://github.com/henryliuwork/SiteIndex/issues/100) 复核冷启动、新建项目路径/执行设备、Skill 安装与计划任务；真实 Windows 与 macOS 的未经验证项保持未完成。
- 只有 G3/G4 通过才进行版本号、tag、Release；不要以本地 `pnpm test` 代替 CI。

**C 交付**：带复现与修复证据的 PR、三系统 CI、Windows 打包 CLI 回归记录、对 E 的安装包/测试指令。

## 6. D · UI 项目页面

**D0 先收尾 [#159](https://github.com/henryliuwork/SiteIndex/pull/159)**
- 确认最新 rebase 与 CI，协助审核者复核后等待合并。不要自行合并 PR，也不要叠加修改相同页面。

**D1 页面 ↔ Core 真数据联调（G2 后）**
- 库存页：关注分类筛选与默认分类开关；30/60/90/全部趋势；价格变化筛选/详情；父 SKU 汇总。只有启用 `sku_grouping` 且 Core 返回可靠映射才显示父级汇总，不计算父级在线率，数量由子项聚合。
- 项目设置：博客 sitemap / URL 模式、父 SKU 规则编辑与实时预览、关注分类勾选与手动录入；保存后能够看到真实结果，并处理错误/空结果。
- SEO 页：按 `issue_counts` 显示问题类型和数量，筛选组合一致；只保留单页 Google 检查，取消批量入口。
- 运行页：顺序为“立即执行 → 定时计划 → 运行历史”；实际 Job 进度、停止、失败原因、计划弹窗一次保存与系统调度模式与 C 一致。

**D2 异常与视觉验收**
- 覆盖真实 IPC 加载/空/失败/partial、窄窗口与 25+ 分类。固定列宽，不因按钮文案切换导致跳动。
- 只改 D 所有页面及对应 `pages/<page>/page.css`、对应 mock 命名空间。需要共享组件调整时通过 Issue 找 B；需要 API 变化时找 A/C 走契约流程。

**D 交付**：按页面或同一功能链提交小 PR；提供前后截图、真数据路径、mock/IPC 测试结果；对照 [#168](https://github.com/henryliuwork/SiteIndex/issues/168)、[#170](https://github.com/henryliuwork/SiteIndex/issues/170)、[#171](https://github.com/henryliuwork/SiteIndex/issues/171)、[#174](https://github.com/henryliuwork/SiteIndex/issues/174)。

## 7. E · 独立验收（只读产品代码）

**E0 先建立两栏证据表**
- 左栏 `v0.1.4 Release` 已确认问题（#163–#174），右栏 `main / candidate` 代码证据与候选包实测状态：`未验证 / 仍复现 / 已修复 / 不适用`。
- 不把“PR 已合并/CI 绿”当作 `已修复`；不在未运行候选包前关闭 Release 问题。

**E1 候选包测试（G3 后）**
1. Windows 11 干净安装、选择项目根目录、新建向导与 init 8 步；验证路径无重复层级。
2. 用真实项目运行 daily、weekly、validate/readme；以 CLI 查询对照 UI SKU/父 SKU、库存、价格、分类、SEO 问题与博客数量（真实数据不提交仓库）。
3. 核实业务日期与时区，若只有 1 天历史则趋势应只有 1 点；30/60/90/全部不能伪造历史。
4. 验证 CLI `run daily/weekly/validate --json` 与 Desktop `--run-job`，尤其 schema 资源位置、退出码和文件写入。
5. 验证运行中进度、取消、失败原因、计划弹窗；关闭软件后的 Windows 计划任务触发与 UAC/常驻回退。
6. 验证 README 用户规则只读/编辑、项目设置保存、Skill 分发、SEO 单页收录打开、UI 小窗口和性能。
7. 完成 PRD §8 的 8 个端到端场景；macOS 可验证的内容单列，不能用 Windows 结果替代。

**E2 Issue 与结论**
- 每项记录：版本/tag/commit、系统、步骤、期望与实际、结构化 `code`/`message`、证据、责任工作流。仅创建/更新 Issue 与虚构 fixtures，不改产品代码、不合并 PR。
- 发布前输出一份 `通过 / 阻断 / 已知可延期` 清单，阻断项必须明确解决或经用户批准延期。

## 8. 推荐 PR 队列（单工作流内部串行，跨工作流并行）

| 优先级 | 负责人 | PR 范围 | 依赖 |
|---|---|---|---|
| P0 | 审核者 / D | #159 最终审核合并 | G0 |
| P0 | A | `contract/sku-preview` 可选接口 + `PENDING_HANDLERS`；历史范围另走 `contract/inventory-history-range` | 无，等待其他 contract PR 关闭 |
| P0 | C | Windows CLI schema 资源路径与安装版回归 #163 | 无 |
| P0 | E | v0.1.4 Issue 证据对照表 | 无，只读 |
| P1 | A | A-2 父子 SKU Core + A-4 关注分类（必要时拆分） | G1 |
| P1 | A | A-5 历史范围 + A-6 价格历史（分 PR）；A-5 UI API 参数放行需 A0b | G1 + 兼容 mock 适配 |
| P1 | B | 共享层可访问性/10k 性能测量 | 无 |
| P1 | C | `sku.previewGrouping` handler、契约待实现清单清零 | G1 / A 能力就绪 |
| P1 | D | 项目设置/库存/SEO 真实数据联调 | G0 + G2 |
| P1 | A | A-7 SEO 规则扩充、schema 与测试 | G1（需要新字段时） |
| P2 | A/C/D | 批量 index-check 清理，单页 Google URL 保留 | 使用方迁移协同 |
| P2 | E | 候选包真实项目、CLI、计划任务与 PRD §8 验收 | G3 |
| P2 | 协调者 / C | 文档同步、版本、Release | G4 |

## 9. 每个 Agent 回报统一格式

完成一项后只回报可核对事实：

1. 本次任务 ID、基线 main SHA、分支、PR 链接；
2. 修改文件与行为变化；
3. `pnpm typecheck`、`pnpm test`、适用的 build 与三系统 CI 结果（未运行要写“未运行”）；
4. 对照验收条件的证据，含失败/限制；
5. 是否变更 shared 契约、需要谁 rebase、下一项建议；
6. 不得自行合并，也不得自动开始跨工作流文件修改。

## 10. 完成定义（DoD）

- A/B/C/D 任务链真实连通：feed/sitemap → Core 数据文件与视图 → IPC → UI，含配置保存与刷新。
- 所有新字段有确定含义与单测，schema/文档/fixture 对齐；没有凭空补历史数据、父级在线率或 Google 收录结果。
- Windows/macOS/Ubuntu CI 通过；Windows 候选安装包 CLI 与 GUI 核心路径一致；E 完成并记录 PRD §8 全流程。
- `#163–#174` 每项明确指向候选版实测结论；阻断项处理完毕。Release 前更新过时的 README（“三个工作流”）、PRD/ARCHITECTURE 中批量收录方案、任务清单与 AGENTS 链接。
- v0.2.0 的版本/tag/发布由审核者在 G4 后单独执行，本文的创建不构成发版授权。
