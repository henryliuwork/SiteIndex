# SiteIndex v0.4.1 · E 合成验收矩阵

## 基线与边界

依据 `docs/plan/2026-11-05-v040-roadmap.md` §4.5、§4.6、§5 E，以及已合并 K5 契约 PR [#390](https://github.com/henryliuwork/SiteIndex/pull/390)（合并提交 `b73b3a0`）。K5 规定了 `media.prepare`、401/403 停批语义、`feed_anomaly`、旧版 `sku_media` 台账扩列和敏感凭据边界；这些契约本身不证明 Core、CLI、Desktop 或 UI 行为已实现。

本矩阵只使用 `synthetic-shop.test`、`SYN-*` 虚构 SKU、内存中的假媒体和 loopback 服务。服务只能绑定 `127.0.0.1`，不记录请求头或请求正文，不访问真实站点，不上传真实媒体，不迁移真实项目，也不在本机安装应用。

本次基线为 `origin/main` `b4073524df0fa8fe6487c1a64380ad497e5de659`（2026-11-12 复核；已含 #390、#414、#416、#417、#419、#421、#431、#432、#433、#437、#438、#442、#443 等合并项）。`media.prepare` 与 `edm.exportIndex` 仍在 `PENDING_HANDLERS`；Desktop 的 `media.prepare` 能力闸也会在读取凭据或启动 worker 前返回 `NOT_IMPLEMENTED`。库存核验已合并到 main。代码、fixture、UI mock 与三系统 CI 均不能替代打包 IPC 或真实环境证据。

PR #440（head `708a40f3a1c78cce78fec8738bfcfd3b6e531b51`）尚未合并。其三系统 CI 通过，但专用 Windows 打包验收 run `43046081311` 在旧版 v0.4.0 packaged launch 阶段失败，未进入候选版升级或凭据 IPC 流程；具体证据与隔离缺口见“#440 托管运行结果与未执行项”。

## 证据层级

| 层 | 能证明什么 | 不能证明什么 | 当前状态 / 固定证据 |
|---|---|---|---|
| L0 Loopback 夹具自测 | 假 GraphQL / WordPress 服务的状态响应、汇总请求计数、上传持久化后断连、假凭据扫描器、验收输入与 oracle 结构 | SiteIndex 是否正确调用服务、Job/IPC/UI 是否正确 | 已合并 #414 / #438；#438 两个 Node 测试文件 17/17 通过，CI run `43037906186` 三系统通过 |
| L1 Core / CLI | 固定提交上的 Core/CLI 对虚构项目和 loopback 响应的行为 | 安装包、Desktop IPC、页面、真实 WordPress 权限 | 库存核验 #417 已并入 main；CI run `43031610742` 三系统通过。media/export 仍未接通 |
| L2 打包 IPC / 页面 | 指定安装包中 renderer、preload、IPC 和 Desktop handler 的实际交互 | 真实站点的安全插件、CDN 或账号行为 | 未验证。#440 run `43046081311` 在旧版 v0.4.0 启动失败，双 origin 流程未执行 |
| L3 真实测试环境 | 用户授权的测试 WordPress 账号和虚构媒体上的端到端结果 | 真实生产账号行为不由本矩阵推断 | 本轮不执行；需要单独授权和候选包 |

## 当前 main 提交与 CI 证据

当前基线是 `b4073524df0fa8fe6487c1a64380ad497e5de659`。下表只把 CI 与测试归入它们实际验证的证据层；fixture/mock 结果不标成产品验收通过。

## E 持久化后错误响应与重试夹具

- 在本次 `main` 基线中，`createFakeWordPressService` 可在 POST 成功持久化后断开连接，并可按 slug GET 查到对象；其 `rateLimitAfter` 在 POST 处理和媒体持久化前就返回 429，`mediaPostStatuses` 的非 201 也在持久化前结束。因此，当前 main 不能直接表达“POST 已创建媒体后返回 429”。
- #439 最新 head `54cfbbd489e9b2a7915c6d18cd65933c49089a39`（截至检查时仍开放）新增 `persistMediaBeforePostFailure`，并加入持久化后 422/429/500/302 用例。其 `job-export-acceptance.test.mjs` 未随 case ID 变更，仍断言旧的固定 ID 列表；直接运行该 Node 测试会拒绝新向量，需 A 更新断言/用例执行。最新 head Actions run `43052780242` 已通过，但这不证明该独立 Node fixture runner 实际执行，也不等于 Core Job 的重试或台账迁移通过。
- 本分支在独立子目录 `retry-after-persist/` 增加 E 自有 loopback 服务、场景 JSON 和 Node 测试，保留两类批处理语义：①源图/参数等本地校验在发出 HTTP 请求前失败，已知无副作用，可继续处理后续 SKU；②POST 已发出后收到 422/429/500 或连接断开，一律 `outcome_unknown` 并停止后续 SKU；恢复时先按确定性 slug GET 查重，命中则复用、不盲目重发 POST。测试还检查既有旧台账 8 列输入与 10 列首次写入 oracle。独立测试 5/5 通过；与现有 L0 测试合计 22/22 通过。
- 新增服务只绑定 `127.0.0.1`，假凭据由现有 canary helper 生成，请求体/头不进入快照；这些结果只证明 E 夹具能表达场景、测试 oracle 一致。retry/preflight driver 不是 SiteIndex 客户端，旧台账测试也只是比较输入与迁移期望文件；Core、CLI、Desktop IPC/页面、打包安装和真实 WordPress 的行为均未验证。待 #439 合并后，仍需由 A 对 Core media Job 做实际调用与本地校验继续、持久化后错误/断连停批恢复、旧台账首次写入迁移验收；随后再由 C/E 完成打包接线验收。

| 范围 | 固定提交 | 对应 CI / 结果 | 证据层与限制 |
|---|---|---|---|
| K5 媒体 / 库存契约 #390 | head `ef0ef40a64473bdc079d896f2afaa52d643a4f54`；merge `b73b3a07b1e412dff8614e61b9dd22ce9c085f89` | [run `42979406654`](https://github.com/henryliuwork/SiteIndex/actions/runs/42979406654)：三系统全通过 | 契约证据：定义错误码、`feed_anomaly`、媒体结果和旧台账尾列；不证明 Core / Desktop 行为 |
| loopback 服务夹具 #414 | head `db64b0848843ad81e21ccb4ea5881508e35849d6`；merge `21d11daa4e794f066d6abf30ea7db4fdb8bf402a` | [run `42980739511`](https://github.com/henryliuwork/SiteIndex/actions/runs/42980739511)：Windows / macOS / Ubuntu 全通过；PR 记录 Node fixture 7 项、Vitest wrapper 1 项通过 | L0：只验证伪服务响应和计数 |
| Core 库存核验 #417 | head `1c05ebdc63f2fdddc98f6b6b93ce91f682e16b22`；merge `4a6b71e39e2e3a99dfd250bef9d16c0cfaabf231` | [run `43031610742`](https://github.com/henryliuwork/SiteIndex/actions/runs/43031610742)：最终 head 三系统全通过；#421 在当时快照 `23c35c76c59f7dbcc469bfbd672ae8f1fd808428` 记录定向 stock tests 11 项通过，覆盖 404/410、GraphQL / 页面回退、不可用响应、轮转与输出故障恢复 | L1：Core / CI，不含打包或真实站点证据；重试覆盖不是 OS 进程重启 |
| mock UI #419 | head `04c506e69980550ecc0414c264afeb7de85bbedb`；merge `ed3af27c4814a14c441a7328096fe284f64c4d89` | [run `43000160593`](https://github.com/henryliuwork/SiteIndex/actions/runs/43000160593)：三系统全通过；PR 记录 mock UI 测试与 `ui:check` 通过 | L0/UI mock：没有媒体 Job、IPC、台账写入或真实上传 |
| E 验收矩阵 #421 | head `c0e58483fa62fbbf3b496b4b460b70121ab62a86`；merge `04ac4ac464ac83adf0885c25bdfb938d11789d97` | [run `43012366436`](https://github.com/henryliuwork/SiteIndex/actions/runs/43012366436)：三系统全通过；PR 记录 loopback 7 项、固定快照的 stock-verification 11 项及清单结构校验通过 | 矩阵 / fixture 记录；不是独立的打包验收 |
| media / 导出夹具 #438 | head `259fc6d7f8b6dfa3ce5ad925fa2d03763e22e48c`；merge `cd79a04aa3f249c2bf38bb874daecfae512940ca` | [run `43037906186`](https://github.com/henryliuwork/SiteIndex/actions/runs/43037906186)：三系统全通过；`fake-services.test.mjs` 与 `job-export-acceptance.test.mjs` 共 17/17 通过 | L0：只验证 loopback 服务、fixtures 与验收 oracle |
| Desktop 私有凭据边界 #416 | head `1b73af333ea5c71aadfa5d60d3f43eafa6a2771c`；merge `1d78c98f196f98d97017514700743b9f2a5126df` | [run `43004046926`](https://github.com/henryliuwork/SiteIndex/actions/runs/43004046926)：三系统全通过；PR 记录 Desktop 定向 33 项通过 | L1/Desktop 单测：媒体能力闸保持关闭并返回 `NOT_IMPLEMENTED`；不是可执行 media Job 或打包凭据跨进程验收 |
| EDM 导出 / 恢复契约 #431 | head `bd10ac3ba93b3a9c87874cda1bca61db56b384cb`；merge `f1f7f5922fcfdd6dd26c9501b82fe2a4f3314e3d` | [run `43027579019`](https://github.com/henryliuwork/SiteIndex/actions/runs/43027579019)：三系统全通过；shared contract test 27 项通过 | 契约/边界证据：`edm.exportIndex` 与 media 恢复字段仍待 Core、Desktop handler 实现与接线 |
| hosted isolation / 双站点流程 #440 | PR head `708a40f3a1c78cce78fec8738bfcfd3b6e531b51`；测试 merge ref `fc38f5ee0661d72364b1de8dfda951ae050d0ae3`；未合并 | [常规 CI run `43046080950`](https://github.com/henryliuwork/SiteIndex/actions/runs/43046080950)：三系统通过；Windows 154 个测试文件通过、1 个跳过，814 项通过、6 项跳过，typecheck、source check、Desktop build 通过。 [E Windows run `43046081311`](https://github.com/henryliuwork/SiteIndex/actions/runs/43046081311)：失败于 v0.4.0 packaged launch | L2：没有候选版或双 origin IPC 运行证据；详见下文 |

## 验收项

| ID | 覆盖项与虚构输入 | 步骤 | 通过标准 | 证据层与当前状态 |
|---|---|---|---|---|
| INV-01 | Feed 缺席但页面 / GraphQL 有货；另含缺货、预售 | 以完整非空 Feed 跑 daily；仅核验 active 且缺席 SKU | 有货 SKU 保持 active、库存变为 `in_stock`，生成一条 `feed_anomaly` 库存事件与 summary 项；不写 SEO issue。缺货 / 预售按配置更新 | L1：#417 已并入 main `4a6b71e`；`stock-verification.test.ts` 覆盖 legacy/workspace 与 GraphQL 业务结果；PR head 全平台 CI 通过。正式安装包未测 |
| INV-02 | 产品页 5xx、GraphQL 429、损坏响应、未知文案 | daily 对旧库存为有货及缺货的 SKU 分别返回不可用 | 原 `stock_status`、`since`、`checked_at` 保持；Job 标 `partial` 并报告不可用数；不误标 removed | L1：#417 已并入 main；测试覆盖 5xx、超时、损坏响应及可靠页面文案回退。请求节流 / 失败保持旧状态由 CI 覆盖；安装包未测 |
| INV-03 | 产品页 404 / 410 | 对当前 Feed 缺席 SKU 分别返回 404、410 | 只移除对应 SKU，`removed_reason=feed_absent_404`，删除其最新库存行，每 SKU 一条移除事件；不得再发 GraphQL 请求 | L1：#417 已并入 main；Core 测试覆盖；正式安装包未测 |
| INV-04 | 两条以上候选、每轮上限 1 或 2；中途有 SKU 加入 / 回到 Feed | 每轮显式传入 `date` 与 UTC `now`；用 `inventory_latest.checked_at` 变化得到无序访问集合，再读取游标 `last_sku` | 每轮不超过上限；已回到 Feed 的 SKU 不再请求；每轮无序访问集合与保存的 `last_sku` 符合预期轮转；候选集合变动后没有饥饿。该组合验证轮转状态一致性，不是网络请求先后顺序的直接观测 | L1：#417 已并入 main；测试覆盖轮转、候选集合变化、上限和失败路径；无 per-SKU 请求正文记录。重试测试是函数重跑，不是 OS 进程重启 |
| INV-05 | 事件、`inventory_latest`、SKU catalog、daily summary 四个输出目标逐一注入写入失败 | 逐个将 one-shot `atomicWrite` 故障注入目标；保留事务清单 / 备份后再次调用并切到 5xx | 重试先恢复同一批次所有目标；待处理游标不提前提交；重跑报告不可用且不产生错误下架或重复事件 | L1：#417 已并入 main；transaction / stock verifier 测试覆盖输出故障回滚、pending 状态和重试；不等同于 Windows 安装版或进程被强杀恢复 |
| INV-06 | 空 / 损坏恢复清单、越界目标路径、缺失备份、恢复期间外部编辑目标文件 | 分别启动恢复逻辑并核查原件和恢复材料 | 必须 fail closed；不得清理唯一备份或清单，不得写入清单允许范围之外的文件，不得静默覆盖外部编辑 | L1：#417 已并入 main；测试覆盖 JSON-null 清单、缺失备份、junction/symlink 祖先、恢复前后外部编辑保护。空/截断清单与任意越界目标路径未逐项独立证明；候选包未测 |
| MED-01 | 假 WordPress 当前用户接口：401 与 403；批次含前置成功和未开始 SKU | GET 当前用户能力，再提交多 SKU 媒体 Job | 401 为 `WP_AUTH_FAILED`、403 为 `WP_FORBIDDEN`；立即停批；保留先前成功项，未开始 SKU 保持未决；错误文案不含认证响应或凭据 | L0：假服务支持且自测；L1/L2：媒体 Job 与 handler 未接通，未验证 |
| MED-02 | 一批 SKU 中包含发送前本地校验失败、后续有效 SKU，以及已发送 POST 后的 422/429/5xx/断连 | 本地校验失败时确认该 SKU 没发出 HTTP 请求，并观察后续 SKU；另对已发出的 POST 分别注入持久化后错误/断连，检查逐 SKU 结果、后续 SKU 与恢复查重 | 只有可证明发生在发送前的本地失败可记为已知失败并继续；任何已发送 POST 的 422/429/5xx/断连都按 `outcome_unknown` 停批，后续 SKU 标为未开始；重试先按确定性 slug GET，命中则 `reused`，不得盲目 POST。401/403 仍按 MED-01 停批 | L0：E 独立夹具 5 项和既有 17 项通过；只证明场景/Oracle。main 旧 `MEDIA-ordinary-partial-then-continue` 把 POST 后 503 作为可继续向量，与此边界冲突，待 A 更新；Core Job 未验证 |
| MED-03 | 假上传端保存媒体对象后断开连接，下一次 GET slug 查重命中 | 第一次上传后模拟连接断开；重试同一 SKU、同源图指纹 | 重试复用已存在对象（`reused`），只保留一个假媒体对象、一次成功上传记录和一条台账行；`media_id` / `source_hash` 稳定 | L0：假服务已覆盖“保存后断连”和后续 GET 查重；SiteIndex 客户端是否先查重未验证 |
| LED-01 | 旧版 8 列 `sku_media.csv` 与两条虚构旧记录 | 先只读导入；再触发第一次真实写入 | 读取 / 导入时文件字节不变；首次写入才将 `media_id,source_hash` 追加为第 9、10 列，保留旧列和旧值，旧行新增列留空 | L1：#390 契约与 shared contract tests 约束表头；Core 文件迁移尚无验收证据 |
| SEC-01 | 只在测试进程使用的假凭据 canary | 将假值投放到模拟凭据源并扫描模拟日志、Job、IPC、CLI/MCP 与导出边界 | 公开输出不包含假值；扫描器只返回匹配类别 / 数量，不返回命中内容。另核验错误码、提示及结果不回显响应正文 | L0：假 canary 扫描器自测；产品日志/IPC/CLI/MCP 尚未逐层验证 |
| SEC-02 | 两个不同的虚构 HTTPS origin A / B；只用 #433 的固定假用户名和假密码 | 打包 renderer 中对 A、B 分别 configure；停止并重新启动同一安装版进程；分别读取 status；replace / delete B 后再重启并核对 A/B 状态 | 状态按 origin 隔离并跨进程保留；replace/delete B 不改变 A；preload IPC 结果只含状态，不回显凭据；DOM、浏览器存储、日志和可读导出中均没有 canary 明文 | #433 helper 已合并；#440 尝试从打包 renderer 调用但 run `43046081311` 在 baseline 启动阶段失败，故此项未运行；vault 与最终 artifact 明文扫描亦未实现 |
| HOST-01 | 新鲜 GitHub-hosted Windows runner；一个 RUNNER_TEMP 子目录作为唯一测试根 | 启动前将 APPDATA、LOCALAPPDATA、USERPROFILE、HOME、TEMP、TMP 全部重定向到该根；检查 Electron 子进程环境、安装路径和每段 canonical/reparse 路径；退出后只清理并核验该根内数据 | 任一路径逃出测试根、出现重解析点或遗留进程时 fail closed；运行全程不读写 runner 默认用户数据；测试结束无残留 | #440 尝试补齐但仍开放；run `43046081311` 在 v0.4.0 启动失败。代码仍未显式把 `TEST_ROOT` 锚定到 `RUNNER_TEMP`，junction 探针清理根外目标，最终清理前未复核/清理后未断言，详见下文 |
| EXP-01 | 虚构父子 SKU、synthetic 价格等级、tag、jpg/png/webp 与空图台账 | 调用 `edm export-index`，检查生成的 SKU 清单 | 按父 SKU 聚合；图片选择台账主图优先，其次 feed 首图；只输出 jpg/png；无图标记待补图；应用折扣档并写出短描述；不得输出凭据 | L1：导出命令尚未实现，准备项；L2 页面不可替代 CLI 导出证据 |

## #422 / #423 可执行夹具与产品验收边界

### #480 已知云同步目录分类夹具

`project-storage-policy-cases.json` 使用测试进程创建的合成根目录，不包含用户路径。验收要求：配置的 OneDrive 根目录内返回 `known-cloud`；根目录同名前缀的兄弟目录及未配置的第三方路径返回 `unknown`。`unknown` 不是“已确认本机”。测试不访问云服务，也不代表能识别所有同步目录。

`job-export-cases.json` 是 #422 media Job 与 #423 EDM 清单的虚构验收向量；`media-export/` 提供旧 8 列台账、10 列迁移预期、SKU 视图、标签、清单 golden 和冲突目标状态。执行 `node --test fixtures/e-v041-loopback/job-export-acceptance.test.mjs` 只验证 fake WordPress 响应与夹具内部一致性。

| 场景 | 夹具可独立验证 | 仍需 Core / Desktop 产品证据 |
|---|---|---|
| 401 / 403 停批，保留先前成功并标出未开始 | Fake service 可按 POST 序列返回 201 后 401/403；记录固定路由和状态计数 | `media.prepare` 是否真的停批、是否恢复逐 SKU 结果与 `media_not_started_skus` |
| 普通 SKU 失败后继续；保存后断连 | Fake service 可回 503 后续 201；保存后断连可 GET slug 找回唯一对象 | Job 是否继续、未知结果分区是否正确、重试是否先查重并去重 |
| 重复请求与同日重跑 | manifest 固定去重顺序与 0 次重复上传预期 | Core Job、旧台账解析和实际写入的幂等行为 |
| 旧台账读取 / 首次写入迁移 | 8 列输入、10 列预期、旧列保留字节可检查 | Core 解析、source 枚举/Schema 更新、迁移时序与真实文件不变性 |
| 导出同日重跑 / 冲突 / 响应丢失 | 固定输出 golden、unmarked / 并发改写 / 外部新建目标字节样本及错误 oracle | Core no-clobber / 条件替换、路径祖先检查、unknown 恢复和 IPC 返回 |
| canary 脱敏 | 测试进程运行时生成 canary，扫描器只回报类别和计数 | 产品日志、RunLog、IPC、CLI/MCP、DOM 与导出等每个实际输出面 |

上述用例不是产品结果。当前 main 的 `media.prepare` / `edm.exportIndex` 仍是 pending handler；Core media Job、RunLog 恢复字段、旧台账迁移、导出写入、固定安全相对路径、冲突保护与未知写入结果处理仍没有产品验收证据。折扣档选择和舍入规则也需在生成产品 golden 前确定。Desktop 有安全闸关闭的 media handler，不代表媒体 Job 可运行。#440 已接上 hosted packaged 流程，但本轮在 baseline 启动失败，故包级测试仍未完成。

## #434 / #440 托管包凭据验收状态

| 阶段 | 当前证据 | 状态 / 下一步 |
|---|---|---|
| L0 loopback 假服务与 #422/#423 用例夹具 | `fake-services.test.mjs` 覆盖 GraphQL 计数/429、WordPress 401/403/429、保存后断连、混合上传和 canary；`job-export-acceptance.test.mjs` 覆盖中断序列、断连后 GET 查找、旧/新台账、旧 RunLog、golden 与冲突/unknown oracle | #438 两文件 17/17 通过；CI run `43037906186` 三系统通过。仅证明假服务和夹具一致性 |
| L1 浏览器 UI helper / mock | #433 helper 包含 configure / replace / delete / assert-status 与 otherOrigins 断言；#419 mock 不调用上传、Job、IPC 或台账写入 | UI helper / mock 证据仅限 UI。#419 CI run `43000160593` 三系统通过；不得升级为产品媒体或打包 IPC 通过 |
| L2 runner 隔离 | #440 将六个 profile 环境变量传给 installer/Electron 子进程并预检计划路径；但 `TEST_ROOT` 由 `os.tmpdir()` 创建，workflow 没有显式将它锚定到 `RUNNER_TEMP`。junction 探针目标位于 `TEST_ROOT` 兄弟目录，finally 会删除根外目标；最终删除根前没有复核/清理后没有断言。报告也没有实际子进程环境快照或活动进程 executable path 观测 | 未满足 #434 的全部隔离与取证要求。修正 root 锚定、根外副作用/清理、最终残留断言与运行时路径证据后再复核 |
| L2 打包 IPC / 跨进程 | #440 将 #433 helper 接入候选安装包 CDP 流程，并统计 preload 的 status/save/clear 方法名 | run `43046081311` 在旧版 v0.4.0 packaged launch 阶段失败：`CDP targets=[]`。没有进入旧版 IPC 检查、候选版升级、W2、`SITEINDEX_TRACE`、双 origin configure/restart/replace/delete、IPC 计数、泄漏断言或截图；这些全部未验证 |
| L3 真实 WordPress | 无真实账号或站点访问 | 本轮不执行；仍需单独授权。`media.prepare` / `edm.exportIndex` 未接通，不调用上传流程 |

### #440 托管 Windows run 43046081311 详录

- Workflow checkout 的 PR merge ref 是 `fc38f5ee0661d72364b1de8dfda951ae050d0ae3`，合入测试时的 main base `ce3507021df97f06be80061f3e9cbbe4c60bb450` 与 PR head `708a40f3a1c78cce78fec8738bfcfd3b6e531b51`。Runner 是 GitHub-hosted Windows Server 2025，build `26100`，image `win25-vs2026/20261103.298.1`。
- `SITEINDEX_CANDIDATE_ARTIFACT_SOURCE=runner-built-internal-candidate`、candidate version `0.4.1`、`HOSTED_UPDATE=false`。构建的是 runner 内部候选安装器，不是已发布 v0.4.1 Release 包；候选安装器结构检查通过（6 个引用资源、67 个 UI 文件、65 个 assets）。
- v0.4.0 官方 baseline tag / asset id / SHA256 下载校验通过，安装到隔离安装目录后，流程在 `v0.4.0 packaged launch` 失败，日志原文为 `Packaged app did not load the complete file-based UI page; CDP targets=[]`。run 的总结果为 failure。
- **实际未执行**：baseline 的 `appState` / 旧版 IPC 验证；0.4.1 覆盖安装与启动；W2 和 workspace IPC / 页面；`SITEINDEX_TRACE` 添加已有项目计时；创建两个虚构凭据项目；双 origin 状态、配置、跨进程重启、替换、删除；凭据 IPC 计数与泄漏断言；最后的候选包截图。不得把这些列为通过或失败，它们均是未验证。

### #440 当前可见的隔离与泄漏取证缺口

1. `TEST_ROOT` 由 `mkdtemp(path.join(os.tmpdir(), ...))` 创建。workflow 使用 `RUNNER_TEMP` 放报告与安装包，但没有把这一个 profile/test root 显式定到 `RUNNER_TEMP`，所以不能证明符合 HOST-01 的唯一根要求。
2. junction escape probe 把 target 创建在 `dirname(TEST_ROOT)`，并在 `finally` 中删除这个根外目录；正常验收数据和清理应限制在经过验证的 root 后代。最终删除 `TEST_ROOT` 前没有重新检查 reparse/包含关系，删除后也没有断言目录消失。
3. Electron `spawn()` 收到构造好的六个环境变量，但报告没有观测实际子进程的六项环境值或活动进程 executable path。项目 `projects_root` 设置回读只能证明一项应用配置，不能代替逐项运行时取证。
4. helper 检查 DOM 与浏览器存储，preload trace 只打印 IPC 方法名，`safeMessage` 会替换已知固定 canary。但 runner 没有扫描可读 vault 文件、完整日志和最终 summary/artifact 的 canary 命中，也没有以统一扫描结果证明 IPC 结果不含明文。#440 的泄漏验收因此仍未完成。

## 可观察性与 GraphQL epoch 切换

伪 GraphQL fixture 的响应配置不可变，快照不保存请求 SKU 或请求正文。访问集合从每轮前后的 `inventory_latest.checked_at` / 状态变化推导；轮转核对比较无序结果集合与 `stock-verification-cursor.json` 的 `last_sku` 是否一致；这是轮转状态一致性检查，不是网络请求先后顺序的直接观测。夹具不保留逐 SKU 请求正文或序列。每轮 `date` 和 ISO UTC `now` 都固定；测试器须将 `now` 转成 `new Date(run.now)` 后传入 `DailyOptions`（或传 `() => new Date(run.now)`），不能把字符串直接传给 Core。`isoInZone` 的 UTC 输出后缀为 `+00:00`；比较时使用该格式或用 `Date.parse` 比较同一瞬时，不能拿 `Z` 与 `+00:00` 做原始字符串比较。不得仅用 `options.date` 推断 `checked_at`。

第六例在 Core 测试夹具里用一次性 `atomicWrite` 故障点制造事件文件已写、`inventory_latest` 写入失败；每个 GraphQL epoch 单独启一个 loopback 服务。每轮结束先 `close()` 旧服务，再用该 epoch 的 `responsesBySku` 新建服务，把新 endpoint 写入同一虚构项目的 `site.json`，然后重新执行 daily。项目台账、恢复清单与游标保持同一份，只有假服务 endpoint 变动。

## 已有测试记录与限制

- Loopback 假服务自测 `node --test fixtures/e-v041-loopback/fake-services.test.mjs`：7/7；仅证明 L0 服务夹具的计数、401/403、429、保存后断连、混合结果与假 canary 扫描。
- K5 `packages/shared/test/media-contract.test.ts`：在基线 `dab4db0efd4fb384cadb502d5d6b372a0ced7c99` 上 8/8；只证明契约，不证明台账文件迁移或媒体处理。
- #417 已合并，main merge commit `4a6b71e39e2e3a99dfd250bef9d16c0cfaabf231`；PR head `1c05ebdc63f2fdddc98f6b6b93ce91f682e16b22` 的 GitHub Actions run `43031610742` 在 Windows / Ubuntu / macOS 均通过。此前 `02b5986` 的 Windows `packages/core/test/io.test.ts` 定向测试 21/21，且 rebase 前后 10 个提交逐项 patch 等价。以上属于 main 代码和 CI 证据，不是安装包或真实站点验收。
- 历史快照：PR #417 的早期提交 `23c35c76c59f7dbcc469bfbd672ae8f1fd808428` 当时尚未覆盖 INV-06 中的恢复完整性 / 外部编辑保护边界；这只描述该固定历史提交，不代表合并后的当前 main。当前覆盖范围见上表 INV-06，仍未逐项证明空/截断清单与任意越界目标路径。
- host identity 测试明示为有起跑屏障的并发 smoke test，不保证两个进程命中内部 read-missing/exclusive-create 临界区，也不构成跨设备分布式锁证明。
- #440 已在 hosted Windows runner 安装并尝试启动 pinned v0.4.0 baseline；因 CDP 无完整 UI target 而停止。候选版内部安装器只通过结构检查，未安装/启动；没有正式候选包 IPC 验收。L3 真实 WordPress 环境未执行。所有未实现或未接线的 API/UI 维持“未验证”，不得用 mock 自测替代。

## 2026-11-12 · 正式候选包凭据隔离补充

当前复核基线为 `origin/main` / checkout `e5aac6163ce025c546406d91ef90f8a516ba01b8`。PR #459 的 Windows 合成打包 E2E 已合并，但测试副本绕过 pending media capability gate；这不等同于正式 Release 安装包、生产媒体入口或真实 WordPress 验收。

C 当前候选包 workflow/script 入口为 `.github/workflows/e-windows-v040-acceptance.yml` 与 `packages/desktop/scripts/e-windows-v040-acceptance.mjs`。静态复核发现 `e-windows-profile-isolation.mjs` 使用实际 `realpath` 与逐级 `lstat`，拒绝路径逃逸和 reparse point；候选包脚本把六个进程环境变量、项目根、vault、安装目录、安装 EXE 与活动进程置于 `RUNNER_TEMP` 隔离根，并查询 Electron 主进程/preload 的 profile 诊断。源码结构复核不是候选安装包运行证据；workflow 运行前仍须由 C 确认本轮输入的正式候选 tag、commit、EXE SHA256 与入口参数。

新增 `credential-isolation-package-acceptance.md` 作为正式候选包执行清单，并新增 `credential-isolation-report-oracle.mjs` 验证脱敏报告：要求六个环境路径项齐全、运行时十个路径观测项均成功、项目/vault/安装边界、重启读回、A/B origin 隔离、reparse 探针、canary 扫描和清理证据齐备；oracle 只输出失败码，不输出路径、凭据或原始报告值。五个必需扫描键（UTF-8、UTF-16LE、Base64 UTF-8、Base64 UTF-16LE、Basic Header）必须全部存在且为数字零；空对象、缺键和非数字计数均 fail closed。其六项 Node 测试只用虚构摘要，不调用 Electron、SiteIndex API、安装程序或真实文件系统。

oracle 数据结构对照 C 当前 hosted 脚本的 `report.credentialIsolation`：脚本已有环境 / runtime path 检查、项目和 vault containment 字段、重启 / 状态 / IPC 计数与 diskScan 五类 key。**但 oracle 当前尚未由 hosted 脚本调用**；CI 的 fixture oracle 通过不表示候选运行入口已集成或可执行。PR #461 要求 C 确认是否在其 runner 汇总步骤接入该 oracle；接入前，正式候选包可用性仍是未验证。

| ID | 候选包操作 | 通过标准 | 脱敏证据 | 当前状态 |
|---|---|---|---|---|
| PKG-CRED-01 | 在 C 确认的 GitHub-hosted Windows workflow 中，以正式候选安装包、固定 tag/commit/SHA256 和 `RUNNER_TEMP` 唯一根执行 `credential-isolation-package-acceptance.md`；配置 A/B 两个 `.invalid` 虚构项目，分别保存凭据，完全重启读回，替换并删除 B 后再次重启读回 | 六个实际 env path + 四个 Electron runtime path 共 10 项 canonical containment 均通过且无 reparse；项目与 vault 在隔离根内；A/B 状态跨重启正确，改/删 B 不影响 A；安装与活动进程位于隔离根；UI、storage、IPC、日志、项目/vault 文件和 artifact 均无 canary；runner 注册表恢复且清理无残留 | tag/commit/installer SHA256、Windows build、runner、路径诊断布尔值与数量、状态别名/阶段、重启布尔值、IPC 次数、canary 匹配类别/计数、cleanup 布尔值；不保留真实路径、canary 或原始日志 | **待正式候选包；本轮仅源码复核和合成报告 oracle 自测，未运行安装包。** schema 已对照源码，oracle 尚未接入 hosted runner；入口参数与接入点待 C 确认 |
