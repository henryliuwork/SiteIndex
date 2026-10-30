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

## 11. 第一轮回报与第二轮执行补充（2026-10-29）

> 此节记录第一轮 Agent 回报后的**新关卡**，优先于本文第 8 节中相同任务的旧排队描述。状态来自 GitHub PR 与 CI；仍以审核者合并时的最新状态为准。

### 11.1 已交付但未合并

| 工作流 | PR | 当前结论 | 下一动作 |
|---|---|---|---|
| D | [#159](https://github.com/henryliuwork/SiteIndex/pull/159) | 已修正 mock 不伪造历史价格/父 SKU；三系统 CI 通过，open、mergeable | 审核者复核后合并；D 后续才修改这些页面 |
| C | [#178](https://github.com/henryliuwork/SiteIndex/pull/178) | 安装版 CLI schema 路径修复；三系统 CI 通过，安装版合成 fixture 无 schema ENOENT | 审核者合并，E 仍需候选包复测 #163 |
| B | [#179](https://github.com/henryliuwork/SiteIndex/pull/179) | 共享组件键盘、焦点与对比度修复；三系统 CI 通过 | 审核者复核后合并；高 DPI 真机仍待 E |
| A | [#176](https://github.com/henryliuwork/SiteIndex/pull/176) | 可选 `sku.previewGrouping` + pending 契约；全套测试因 Desktop 旧断言失败，三系统 CI 红 | **不得合并**；先执行 C-IPC-TEST，再由 A rebase、重跑 CI |

### 11.2 新增阻断关卡 C-IPC-TEST（优先于 C2）

`packages/desktop/test/ipc-contract.test.ts` 的第一个用例将 preload bridge 暴露的 invoke 方法与 `API_INVOKE_METHODS` 直接做全量相等比较。#176 合理地把新方法列进 `PENDING_HANDLERS`，但 bridge 尚未实现可选 `sku`，导致该测试失败；`packages/desktop/src/main/ipc/handler-completeness.test.ts` 已经支持 pending，不必重复改动。

**C 的下一项小 PR**：从最新 `main` 新建 `c/ipc-pending-contract-test`，只调整 Desktop IPC 合约测试，新增 `PENDING_HANDLERS` 感知：

1. bridge 不得暴露 `API_INVOKE_METHODS` 之外的方法；所有**非 pending** invoke 必须暴露；pending 可暂时缺席，也允许后续 C 提前实现，避免第二次迁移再卡住。
2. `PENDING_HANDLERS` 必须是 invoke 清单的子集且不能重复；事件清单仍要求全量一致。
3. 不特殊判断字符串 `sku.previewGrouping`，也不在本 PR 偷做 handler 或修改 shared。旧 `main` 上 pending 为空时，原严格完整性测试仍应通过。
4. `pnpm typecheck`、`pnpm test`、三系统 CI 通过后提交 PR，等待审核者先合并。

**A 的后续动作**：确认 C-IPC-TEST 合并后，将 #176 rebase 到最新 `main`，重跑三系统 CI；三系统全绿后再交审核者合并。A-2 在 #176 合并前只能做只读设计/测试方案，不提交依赖未合并契约的 Core PR。

**PR #178 的自动关闭风险**：当前描述包含 `Closes #163`，合并会自动关闭 Issue，但 E 尚未用 G3 候选 Release 复测。审核者合并前由 C 将其改为 `Refs #163`（普通关联），保留 Issue 的验收状态；若已自动关闭，由 E 依据验收制度重新打开并说明。

### 11.3 第二轮可并行任务

- **A**：先等待 C-IPC-TEST 的合并、修复 #176 CI 并完成契约；随后 A-2 确定性分组引擎与 Core 服务单独 PR。暂不开始 A0b；D 的 mock 需先能兼容 `"all"`。
- **B**：#179 合并后先就 [#177](https://github.com/henryliuwork/SiteIndex/issues/177) 提供共享 `Tabs` / `ProjectHeader` 的稳定 tab ID 与 panel ID 约定，并评估能否在 B 自有的 `App.tsx` 路由壳统一承载 `tabpanel`；不可要求 D 修改 B 文件。与 D 确认后再进行 [#88](https://github.com/henryliuwork/SiteIndex/issues/88) / [#93](https://github.com/henryliuwork/SiteIndex/issues/93) 的 10k SKU 共享 UI 性能基准，分别记录 mock/真实 IPC。真实 Windows 高 DPI 交给 E。
- **C**：先合并 #178，再做 C-IPC-TEST；只有 #176 与 A-2 合并后才实现 `sku.previewGrouping` 的 preload/handler，最后单独契约 PR 清除 pending。避免同时改两条分支中的 Desktop 测试。
- **D**：#159 合并后与 B 协调 [#177](https://github.com/henryliuwork/SiteIndex/issues/177) 的 `tab`/`tabpanel` 语义：B 负责共享 Tabs/ProjectHeader 与全局路由，D 仅修改自身所拥有的项目页面；其他页面归属不明时先由协调者明确，不能越界修改。另先准备库存 mock 接受 14/30/60/90/全部的参数，保持真实 IPC 仅请求已支持的范围，交接 A0b。父 SKU 预览必须在 A/C 就绪后改为 Core 结果。
- **E**：更新 #163–#174 验收矩阵：#178 是“修复 PR 已完成 + 合成安装版验证，但未合并/未候选版复测”，不再写“无修复 PR”；#159/#179 同理标记 PR 状态，纳入 #177。候选包发布前不关闭 Release Issues，亦不将 CI 通过当作实测。

### 11.4 审核者的合并队列

1. 审核并合并彼此独立且 CI 全绿的 #159、#178、#179（顺序可根据 main 冲突与最新 CI 调整）；检查 #178 的自动关闭关键字。
2. 审核并合并 C-IPC-TEST 新 PR。
3. A rebase #176，确认三个系统 CI 全绿后才合并。
4. 进入 A-2 → C IPC → D 真数据预览的能力链；A0b 需等待 D mock 兼容性前置。
5. E 从 G3 候选包重新验收；未有候选包时不得宣告 v0.2.0 完成。

## 12. 第四轮交接与 v0.2.0 发包路线图（2026-10-30）

> **本节为最新执行关卡**，优先于 §8、§11 的旧队列与原第三轮快照；旧节保留为历史决策证据。核对时 `main` = `c7e1176b7acbe350b0d4d2434fc0ddc61d9094ca`，公开 Release 仍是 `v0.1.4`。发包日期是条件预测，不是无需验收的承诺。

### 12.1 已完成与关键缺口

- 已合并：#181（pending-aware IPC 测试）、#176（可选 SKU 预览契约）、#182（库存范围 mock）、#183（共享 tabpanel）、#186（四页归 D）、#187/#188（D 共 11 页接入）、#184（10k SKU 基准）、#189（A-2 Core 分组/父 SKU 视图）、#190（Desktop 启动后台校正）。
- #88 因 #184 合并自动关闭；#92 仍开放（Windows 安装版启动约 1.69 秒，尚未达到 1 秒目标）；#93 仍需正式安装包 10k SKU 首载 10 次验证；#177 虽有代码，仍欠真实键盘与辅助技术验收。
- 当前 shared 的 `sku.previewGrouping` 已列入 `PENDING_HANDLERS`，Core 已实现，但 Desktop IPC handler 与 UI 真数据预览尚未串通；`inventory.summary` 真实范围仍未放行 60/90/全部。
- A 尚未完成：A-4 关注分类、A0b/A-5 历史范围、A-6 价格历史、A-7 SEO 规则计数/筛选、A-9 废弃批量 index-check；这是正式 v0.2.0 的主要关键路径。

### 12.2 五个工作流的下一轮小 PR（不得跨目录）

| 工作流 | 优先顺序 | 完成标准 / 依赖 |
|---|---|---|
| **A · Core** | A-4（关注分类去重和摘要标记）→ 独立 `contract/inventory-history-range` A0b → A-5（30/60/90/全部真实范围）→ A-6（只从真实 events 建价格历史与筛选）→ A-7（SEO `rule` 生成、`issue_counts` 与 `rules` 过滤）→ A-9（协调废弃批量 Job） | 每项独立小 PR；fixture/schema/黄金测试同步；不得伪造日期、父 SKU 库存或价格。A0b 仅当 D mock 和 Core 实现可兼容时合入。 |
| **C · Desktop** | C2 `sku.previewGrouping` preload+handler+错误测试 → handler PR 合并后单独 `contract/*` 清 `PENDING_HANDLERS` → 核查 #91 Design/Categories IPC 与 #100 新建根目录/init → 安装版回归与候选包 | #189 已合并，C2 可立即开始。真实 IPC 不能以 mock/源码构建代替；保持 #92 未达 1 秒的证据，不自关 Issue。 |
| **D · 项目页面** | 等 C2 后把父 SKU 预览从本地前 100 条近似逻辑迁移到真实 IPC；随 A-4/A-5/A-6/A-7 各 PR 增量联调库存/项目设置/SEO；核验 Runs 进度和状态 | 只改 D 自有页面及相关 mock；所有数据链来自 Core，不静默降级成假结果。#177 代码完成不等于实测完成。 |
| **B · UI 共享层与应用级页面** | #82 真实 Electron UI 路由/共享状态辅助检查、#93 packaged 首载与 E 配合；按证据检查并修复 #102 init 新建完成页及 #136 项目中心偶发路由问题 | **已确认** `ProjectCenterPage`、`NewProjectWizardPage`、`SkillsPage` 归 B；可修改这三页及对应局部样式/mock，D 项目业务页仍由 D 单独维护。 |
| **E · 验收** | 先用隔离的 Windows **内部测试包**回归 #163/#91/#93/#100 与启动性能，再准备正式 `v0.2.0-rc1` 的 #163–#174、#177、#82、PRD §8 全矩阵 | 每次记录安装包 SHA256、commit、Windows build、脱敏结果；候选包之前不关闭旧 Release Issue。macOS 独立记录，不以 Windows 替代。 |

### 12.3 发布阻断清单

| 类别 | 阻断 / 风险 | 放行证据 |
|---|---|---|
| **P0 功能数据** | #165 SEO 覆盖；#166 价格历史（父 SKU 已入 main）；#170 关注分类/真实历史范围/价格筛选 | A-4/5/6/7 的 Core 数据、契约、schema、fixture、D 真实 IPC/CLI 数字一致 |
| **P0 IPC/新建** | `sku.previewGrouping` 待 C2；#91 Design/Categories 的旧版 NOT_IMPLEMENTED；#100 根目录重复层级/init 调度；#102 init UI 完成页 | 最新候选包逐项无 NOT_IMPLEMENTED、无重复目录、init 八步可追踪且定时任务正确注册；若已修复，先给出代码与安装包证据再判定 |
| **P0 安装包** | #163 CLI schema 安装路径、#93 10k SKU 首次查询、#82 全路由真实 IPC、#177 tabpanel 实际键盘/读屏 | E 在候选包实测通过，失败有 `code/message` 和复现记录 |
| **P1 可商量延期** | #92 首屏目标 1 秒（当前约 1.69 秒）；#136 偶发路由未复现；#155 Windows 并行测试波动 | 不得静默宣布完成；若无稳定功能性故障且用户批准，可列为已知延期；CI 仍必须全绿 |
| **跨流清理** | A-9 批量 index-check 废弃及 C/共享契约清理 | UI、Core、CLI、Desktop 与 `packages/shared` 清单一致，保留单页 Google 查询入口 |

### 12.4 双轨发包关卡和预计时间（北京时间）

| 关卡 | 预计窗口 | 内容 | 是否面向普通用户 |
|---|---|---|---|
| **T0 内部安装测试包** | **10/31–11/02**（约 1–3 天） | C 从包含 #190 的最新 main 打隔离 Windows 包，E 提前测 #163/#91/#93/#100、启动和路由，立即暴露安装器问题 | 否；不打正式 Release，不宣称 v0.2.0 完成 |
| **G2 功能收敛** | **11/03–11/09**（约 4–8 个有效开发日） | A-4/5/6/7/9，C2/IPC，D 真实数据联调；全部 PR 逐个过三系统 CI | 否 |
| **G3 `v0.2.0-rc1`** | **目标 11/09–11/12** | 功能完整 + Windows/macOS/Ubuntu CI 绿 + 正式候选安装包 SHA/commit 锁定；E 端到端验收 | 仅测试人员 |
| **G4 `v0.2.0` 正式 Release** | **争取 11/13–11/18** | E 候选包通过、阻断项归零或经用户批准延期，再做 tag/Release | 是 |

> 时间窗口按五个 Agent 并行、每天有可审核的小 PR、无新的 P0 缺陷估算。**若 A-7 SEO 规则、#100 init 或安装版 #93 复现出新 P0，日期顺延，不以赶进度为由跳过验收。** T0 可提前发供内部测试，但不等于正式版。

### 12.5 协调者合并与收尾规则

1. C2 handler PR → 三系统 CI → 审核合并；**之后** 单独 `contract/*` PR 移除对应 pending，不在 Desktop PR 越界改 shared。
2. A0b 契约与 Core 范围计算配套推进；D 在真 IPC 支持前继续守住旧参数，不允许页面用 30 天结果假装 90/全部。
3. D 的 #177 十一个项目页及 B 共享层已进 main；E 完成实际键盘、NVDA/Narrator 与高 DPI 后才讨论关闭 #177。
4. Release 前对照 #91/#100/#102/#82 等较旧 Issue 做 evidence-first 反查；Issue OPEN 不能自动等于当前 main 有 bug，代码合并也不能自动等于安装版通过。
5. 根 README/旧任务清单/PRD 的历史版本表述需在 G3 前清理，但保留历史决策记录；本规划 PR 不等于发版批准。
