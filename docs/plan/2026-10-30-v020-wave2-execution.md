# SiteIndex · 单用户快速发版与 v0.2.0 第二轮收敛（2026-10-30）

> 本文更新了 `docs/plan/2026-10-29-v020-convergence.md` §12。**用户最新决定：目前只有自己使用 SiteIndex，不再要求先完成隔离测试；优先直接发布最新安装包，本人安装后集中反馈问题。** 因此原来的 #196 → E 隔离 → T0 放行顺序被本次决定取代。#196 仍保留为未修复 Issue。时间均为北京时间。

## 1. 截止本轮的实际基线

- main：`f0e610a6ebc4609809d0361595933631c437ea45`。
- 本轮已合并：#193（C2 SKU 分组预览 Desktop/preload IPC）、#194（A-4 关注分类汇总/筛选）、#195（B 新建项目 init 状态）。#192 已合并，明确 B 拥有 ProjectCenter/NewProjectWizard/Skills。
- #193 已有 handler，但 shared `PENDING_HANDLERS` 中 SKU 预览待单独契约清理；D 项目设置尚未切到真实预览。
- #194 已进入 Core，D 页面仍需删除本地虚拟补零分类并以 Core 返回的 `watched/manual` 为准。
- #195 已进入 UI，#102 保持 OPEN，安装包端到端测试完成前不关闭。
- T0 Windows 内测包源 commit `72ead80857beaafec0d94a6889c7e9def4900c89`，SHA256 `9CB0DE99C8D7DE0CC6F890AEB13BF41122AB01D7A767027B133D92D9328BBC84`；它早于本轮合并，不是 v0.2.0 RC，也不代表正式验收。
- E 在 T0 上发现 #196：全新 user-data-dir 仍显示既有项目/历史；**已知缺陷，个人测试版不再以其阻断发包**。#163 仅部分 smoke 未见 schema ENOENT；#93 只测得 CLI 10k，未测安装版 UI 首载。

## 2. 优先级与工作流

| 优先级 | 工作流 | 下一轮任务 | 完成/交接门槛 |
|---|---|---|---|
| **P0 / 快速发布** | **C** | 先将 `packages/desktop/package.json` 版本升至 `0.1.5`，单独 PR 后合并，再按 tag 工作流发布 Windows/macOS 安装包；随后独立调查 #196。 | 三系统 CI 全绿、版本与 tag 一致、Release 资产齐全，#196 保持 OPEN。 |
| **P0 / 契约** | **A** | A0b：`inventory.summary` 只扩展可接受范围 `14 | 30 | 60 | 90 | "all"`，独立 `contract/*` PR，不混入 Core/UI/Desktop；先保持旧 14/30 正常。 | 契约类型与测试 CI 三系统通过并合并；同一时刻最多一个 `contract/*` 开放。 |
| **P0 / 数据** | **A** | A-5 Core 使用已存在的业务日期序列支持 60/90/all；A-6 从库存真实 price events 生成 `price_history` 与 `price_changed_within`，不得造数；A-7 生成缺失 SEO 规则、`issue_counts`、真实 `rules` 过滤。 | 各自独立 PR、黄金 fixture/CLI/Core 测试、三系统 CI；#165/#166/#170 数据在 UI 接入前有可复现证据。 |
| **P0 / 联调** | **D** | 先 D3 真实 `sku.previewGrouping`，删除本地 100 SKU 近似分组；另开 D4 关注分类页接 #194 输出，移除本地补零假数据。随后在 A-5/6/7 各合并后依次接真实范围、价格筛选/趋势、SEO 计数筛选。 | 每个 PR 只改 D 页面/对应样式与 mock；真实 IPC 缺席时有清晰的错误态，无虚构库存历史或父 SKU 在线率。 |
| **P1 / 稳定性** | **B** | 对 #195 合并的 init UI 做只读回归和 #136 路由证据审计；仅复现并定位后再建 B 范围的修复 PR。配合 E 提供不含真实数据的键盘/焦点手工验收步骤。 | #136 未复现不可盲改；#102 需 E 安装包复测八步、skip、retry、schedule registered。 |
| **用户反馈** | **E** | 不再阻止用户安装新版；准备实测清单，按用户实际反馈整理脱敏 Issue 与回归矩阵。 | 每项记录版本、步骤、预期/实际和 `code/message`，没有测的不得标通过。 |

## 3. 依赖与契约队列

1. **现在可以并行：** C 先处理 v0.1.5 版本 PR/发包；A A0b；D 真实 SKU 预览与 A-4 分类接线；B #136 只读审计；E 准备用户安装反馈表。
2. **共享契约排队：** A0b `contract/*` PR 先开、先绿、先合并。之后 C（或经协调分配）再独立开 `contract/*` PR，从 `PENDING_HANDLERS` 移除已实现的 `sku.previewGrouping`。不得与 A0b 并行挂两个契约 PR。
3. **历史范围：** A0b 合并 → A-5 Core + C Desktop 传参检查 → D 启用真实 60/90/all。不得将 30 天结果展示为 90 天或全部。
4. **价格与 SEO：** A-6/A-7 真实源数据与过滤实现合并 → D 接 UI。#166 只有 `parent_sku` 部分已进入 main，`price_history` 仍缺；#165 缺失的规则不能靠当前真实站点零命中来认定不存在。
5. **#196 不再是单用户 v0.1.5 的发包前置：** 这是用户明确接受的测试顺序调整，并非确认隔离正常。C 发包后单独追踪修复，未来多用户/隔离场景必须重新验证。
6. **#91/#100** 若安装包复现，分根因在 C 或 A/B 拆 issue/PR；不能仅凭源码已有 handler 就关闭。

## 4. 发包关卡与预计窗口（北京时间）

| 关卡 | 预计时间 | 放行条件 |
|---|---|---|
| **v0.1.5 个人快速验证版** | **10/30–10/31（目标）** | C 版本升级 PR 合并并推 `v0.1.5` tag；Release workflow 打 Windows/macOS 安装包，不等待 #196 和独立 E 隔离测试。 |
| **G2 功能代码收敛** | **11/01–11/10（滚动）** | A0b/A-5/A-6/A-7、D 真数据接线、C pending 清理与 #196 修复；用户反馈按需发 v0.1.6 小修复版。 |
| **G3 `v0.2.0-rc1`** | **争取 11/09–11/12，视 #196 与 A-6/A-7 顺延** | P0 修复合并、main 固定 SHA；正式候选包有 tag/版本/校验值；E 在 Windows 及 macOS 各自记录结果；不得用 source build/mock 代替。 |
| **G4 `v0.2.0`** | **原目标 11/13–11/18，条件达成才发布** | E 候选包所有 P0 通过；#163/#165/#166/#170/#196 及真实 IPC/调度/数据链完成；剩余 P1 经用户明确批准延期。 |

> `v0.1.5` 只是当前已合并功能的个人快速验证版；`.github/workflows/release.yml` 会将所有 tag Release 发布为正式（非 prerelease），所以 Release Notes 要写明“个人验证，尚有待测功能”。`v0.2.0` 仍需后续功能收敛，不应提前打其 tag。

## 5. E 候选包关键先测项

- **单用户安装实测：** 不再要求双 profile 隔离测试。安装前建议备份 SiteIndex 本机设置和要测试的项目目录；由于 #196 尚未修复，新 profile 仍可能展示既有项目。
- **10k #93：** 不用 CLI 查询成功代替 UI 首次加载；在正式安装版里独立进程冷启动 10 次，记录首载状态、数量和时延；任何一次需要点击重试即失败。
- **init #100/#102：** 在独立新项目上检验目录不重复、8 步 ok/failed/skipped、重试后状态、schedule `registered` 实际返回；不得仅凭成功文案验收。
- **IPC/数据：** 从 UI → preload → Desktop → Core → 文件或 CLI 的路径对照：SKU 预览、关注分类、历史日期、价格事件、SEO 规则；记录脱敏数量和结构化 `code/message`。
- **Release 质量：** 三系统 CI 和真正的 Windows/macOS 安装包验证分别记录；#177 必须做真实键盘与 NVDA/Narrator 语义/焦点验证；截图工具不可用允许明确记录无法验证项，但不把它写成通过。

## 6. 分支与验收纪律

- 5 个工作流严格按 `docs/WORKSTREAMS.md`；B 不改 D 项目页，D 不改 shared/Desktop/Core；C 不改 shared 契约，专用 `contract/*` 例外。
- PR 由审核者核对文件范围、回归测试与 Windows/Ubuntu/macOS 三系统检查；使用 merge commit，不自合并，不直接 push main。
- GitHub 仓库公开：真实 Kingsyard 项目名、SKU、价格、URL、路径、私有 token 不进入 issue/PR/截图；只用虚构 fixture 和脱敏摘要。
- **代码合并 ≠ 安装包验收。** #102、#163、#177、#196 及其他 Release 阻断 Issue 只有在相应安装包验证后才考虑关闭。


## 7. 本轮快速发版操作（覆盖前述旧隔离门槛）

1. **C 优先版本 PR：** 从最新 main 创建独立分支，仅把 `packages/desktop/package.json` 的 `version` 从 `0.1.4` 改为 `0.1.5`（必要时同步锁文件），执行 typecheck/test/build，三系统 CI 绿后交审核者 merge commit 合并；不要混入 #196 或其他功能。
2. **C 推 tag：** 确认工作区 clean、`v0.1.5` 不存在且 `node packages/desktop/scripts/check-release-version.mjs v0.1.5` 通过；从已合并 main 创建并推送 `v0.1.5`。Release workflow 会自动创建 Release、打 Windows NSIS 和 macOS universal 包。
3. **发布验收只核对构建本身：** Release Actions 成功；有 `SiteIndex-Setup-0.1.5.exe`、`SiteIndex-0.1.5-universal.dmg`/zip、`latest.yml`/`latest-mac.yml` 与 blockmap；报告 Release URL、完整 commit 和安装包 SHA256。用户安装后的功能通过情况另行记录。
4. **用户本人更新后反馈：** 版本、页面、操作步骤、预期/实际、错误码、是否重试；不向公共 Issue 上传真实 SKU/价格/Feed/密钥。为避免误写生产内容，测试前备份软件配置与项目数据，涉及批量修改或自动任务时优先使用副本。
5. **继续 v0.2.0 功能：** A-5/A-6/A-7 和 D 真数据接线未完成，不因 v0.1.5 发布视为通过；按反馈小版本滚动修复，#196 另行调查且保持开放。
