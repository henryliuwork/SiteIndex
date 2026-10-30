# SiteIndex v0.2.0 · 第二轮收敛与发包门槛（2026-10-30）

> 本文是 `docs/plan/2026-10-29-v020-convergence.md` §12 的增量执行快照。发生冲突时，以本文件记录的 **2026-10-30 GitHub main 状态与本轮约束** 为准；长期分工仍以 `docs/WORKSTREAMS.md`、`AGENTS.md` 为准。所有时间为北京时间。

## 1. 截止本轮的实际基线

- main：`f0e610a6ebc4609809d0361595933631c437ea45`。
- 本轮已合并：#193（C2 SKU 分组预览 Desktop/preload IPC）、#194（A-4 关注分类汇总/筛选）、#195（B 新建项目 init 状态）。#192 已合并，明确 B 拥有 ProjectCenter/NewProjectWizard/Skills。
- #193 已有 handler，但 shared `PENDING_HANDLERS` 中 SKU 预览待单独契约清理；D 项目设置尚未切到真实预览。
- #194 已进入 Core，D 页面仍需删除本地虚拟补零分类并以 Core 返回的 `watched/manual` 为准。
- #195 已进入 UI，#102 保持 OPEN，安装包端到端测试完成前不关闭。
- T0 Windows 内测包源 commit `72ead80857beaafec0d94a6889c7e9def4900c89`，SHA256 `9CB0DE99C8D7DE0CC6F890AEB13BF41122AB01D7A767027B133D92D9328BBC84`；它早于本轮合并，不是 v0.2.0 RC，也不代表正式验收。
- E 在 T0 上发现 #196：全新 user-data-dir 仍显示既有项目/历史；**P0 隔离阻断**。#163 仅部分 smoke 未见 schema ENOENT；#93 只测得 CLI 10k，未测安装版 UI 首载。

## 2. 优先级与工作流

| 优先级 | 工作流 | 下一轮任务 | 完成/交接门槛 |
|---|---|---|---|
| **P0 / 先解锁 E** | **C** | #196 隔离来源与 Desktop 修复。调查 app userData、用户配置、项目注册表/运行历史数据的实际读写根及测试安装包 identity，明确隔离原则。 | C-only 小 PR；两份完全独立的虚构 profile，A 的项目/历史在 B 不可见；旧正式 profile 不被触及；三系统 CI；重建独立 T0 包交 E。 |
| **P0 / 契约** | **A** | A0b：`inventory.summary` 只扩展可接受范围 `14 | 30 | 60 | 90 | "all"`，独立 `contract/*` PR，不混入 Core/UI/Desktop；先保持旧 14/30 正常。 | 契约类型与测试 CI 三系统通过并合并；同一时刻最多一个 `contract/*` 开放。 |
| **P0 / 数据** | **A** | A-5 Core 使用已存在的业务日期序列支持 60/90/all；A-6 从库存真实 price events 生成 `price_history` 与 `price_changed_within`，不得造数；A-7 生成缺失 SEO 规则、`issue_counts`、真实 `rules` 过滤。 | 各自独立 PR、黄金 fixture/CLI/Core 测试、三系统 CI；#165/#166/#170 数据在 UI 接入前有可复现证据。 |
| **P0 / 联调** | **D** | 先 D3 真实 `sku.previewGrouping`，删除本地 100 SKU 近似分组；另开 D4 关注分类页接 #194 输出，移除本地补零假数据。随后在 A-5/6/7 各合并后依次接真实范围、价格筛选/趋势、SEO 计数筛选。 | 每个 PR 只改 D 页面/对应样式与 mock；真实 IPC 缺席时有清晰的错误态，无虚构库存历史或父 SKU 在线率。 |
| **P1 / 稳定性** | **B** | 对 #195 合并的 init UI 做只读回归和 #136 路由证据审计；仅复现并定位后再建 B 范围的修复 PR。配合 E 提供不含真实数据的键盘/焦点手工验收步骤。 | #136 未复现不可盲改；#102 需 E 安装包复测八步、skip、retry、schedule registered。 |
| **P0 / 安全验收** | **E** | #196 未解决前停止安装包 GUI 项目页、真实 IPC 与 10k 首载测试。可继续只读核对 PR/CI、脱敏 fixture、CLI 与候选验收矩阵；不得触碰真实 Kingsyard。 | C 修复 + 新隔离包 + 双 profile 空白证据后重启 GUI；先测试 #196，再 #93/#100/#91/#102/#163/#177/#82。 |

## 3. 依赖与契约队列

1. **现在可以并行：** C #196；A A0b；D 真实 SKU 预览与 A-4 分类接线；B #136 只读审计；E 只读验收准备。
2. **共享契约排队：** A0b `contract/*` PR 先开、先绿、先合并。之后 C（或经协调分配）再独立开 `contract/*` PR，从 `PENDING_HANDLERS` 移除已实现的 `sku.previewGrouping`。不得与 A0b 并行挂两个契约 PR。
3. **历史范围：** A0b 合并 → A-5 Core + C Desktop 传参检查 → D 启用真实 60/90/all。不得将 30 天结果展示为 90 天或全部。
4. **价格与 SEO：** A-6/A-7 真实源数据与过滤实现合并 → D 接 UI。#166 只有 `parent_sku` 部分已进入 main，`price_history` 仍缺；#165 缺失的规则不能靠当前真实站点零命中来认定不存在。
5. **#196** 是 E GUI 测试的硬前置，不受其他 PR 合并情况影响。C 根因若涉及 Core/共享配置，先提交证据、协调跨流小 PR；不要越界直接改 A/Shared。
6. **#91/#100** 若安装包复现，分根因在 C 或 A/B 拆 issue/PR；不能仅凭源码已有 handler 就关闭。

## 4. 发包关卡与预计窗口（北京时间）

| 关卡 | 预计时间 | 放行条件 |
|---|---|---|
| **T0.1 重新打内部测试包** | **10/31–11/03（目标）** | #196 根因已修复，双 profile 不串数据；C 报 commit + SHA256 + Windows 版本，E 能安全打开纯虚构项目。只内部使用，无 Release tag。 |
| **G2 功能代码收敛** | **11/03–11/10（滚动）** | A0b/A-5/A-6/A-7、D 真数据接线、C 契约清理、#100/#91 根因补齐，三系统 CI 全绿；A-9 的旧批量 index-check 清理按契约评估是否阻断。 |
| **G3 `v0.2.0-rc1`** | **争取 11/09–11/12，视 #196 与 A-6/A-7 顺延** | P0 修复合并、main 固定 SHA；正式候选包有 tag/版本/校验值；E 在 Windows 及 macOS 各自记录结果；不得用 source build/mock 代替。 |
| **G4 `v0.2.0`** | **原目标 11/13–11/18，条件达成才发布** | E 候选包所有 P0 通过；#163/#165/#166/#170/#196 及真实 IPC/调度/数据链完成；剩余 P1 经用户明确批准延期。 |

> 这些是计划窗口，不是发布日期承诺。#196 使 RC 与正式版出现新增 P0 风险；若无法在 11/03 前安全恢复 E GUI 验收，应明确顺延。当前 #92 约 1.69 秒相对 1 秒目标仍是开放的 P1，不得静默标绿。

## 5. E 候选包关键先测项

- **隔离第一：** 两个从未使用的 profile A/B，分别注册不同的纯虚构项目。B 的项目中心与 Runs 必须仅出现 B 自身数据，初始 B 必须完全空白，互相绝不串历史；并确认不会读取/修改用户正式数据。
- **10k #93：** 不用 CLI 查询成功代替 UI 首次加载；在正式安装版里独立进程冷启动 10 次，记录首载状态、数量和时延；任何一次需要点击重试即失败。
- **init #100/#102：** 在独立新项目上检验目录不重复、8 步 ok/failed/skipped、重试后状态、schedule `registered` 实际返回；不得仅凭成功文案验收。
- **IPC/数据：** 从 UI → preload → Desktop → Core → 文件或 CLI 的路径对照：SKU 预览、关注分类、历史日期、价格事件、SEO 规则；记录脱敏数量和结构化 `code/message`。
- **Release 质量：** 三系统 CI 和真正的 Windows/macOS 安装包验证分别记录；#177 必须做真实键盘与 NVDA/Narrator 语义/焦点验证；截图工具不可用允许明确记录无法验证项，但不把它写成通过。

## 6. 分支与验收纪律

- 5 个工作流严格按 `docs/WORKSTREAMS.md`；B 不改 D 项目页，D 不改 shared/Desktop/Core；C 不改 shared 契约，专用 `contract/*` 例外。
- PR 由审核者核对文件范围、回归测试与 Windows/Ubuntu/macOS 三系统检查；使用 merge commit，不自合并，不直接 push main。
- GitHub 仓库公开：真实 Kingsyard 项目名、SKU、价格、URL、路径、私有 token 不进入 issue/PR/截图；只用虚构 fixture 和脱敏摘要。
- **代码合并 ≠ 安装包验收。** #102、#163、#177、#196 及其他 Release 阻断 Issue 只有在相应安装包验证后才考虑关闭。
