# v0.4.1 正式候选包虚构数据验收准备

## 基线与边界

- 固定基线：origin/main e976bdbafcd801a4de9fa8b57352bb9124dd411d。
- 路线图：docs/plan/2026-11-05-v040-roadmap.md §4.5、§4.6、§5 E；输入数据与证据层沿用 v041-acceptance-matrix.md。
- 本文件只补候选安装包执行顺序，不把 Core、CLI、loopback fixture、UI mock 或 CI 结果算作 NSIS 通过。
- 项目、SKU、价格、媒体和凭据均为虚构。本轮不访问真实站点、WordPress、用户项目或用户 profile；不安装候选包、不触发 Release、不发布版本。

## 隔离环境与候选包入口

| 条目 | 要求 |
|---|---|
| 执行环境 | GitHub-hosted Windows runner 的新鲜临时 VM；不在日常电脑或已有安装上操作 |
| 唯一根目录 | C runner 在 RUNNER_TEMP 下建立唯一 siteindex-e-acceptance-* 根；安装目录、项目、profile、报告和媒体均置于其内 |
| profile | APPDATA、LOCALAPPDATA、USERPROFILE、HOME、TEMP、TMP 全部重定向到根内；核验 Windows AppData 重定向、Electron 主进程/preload、安装 EXE 与活动进程路径 |
| 路径安全 | 逐项 canonical containment 与 reparse 检查；junction 探针也位于 RUNNER_TEMP；清理前复核根仍在界内，清理后断言根和进程无残留 |
| 网络 | workflow 先下载并校验基线/候选资产；应用侧库存和媒体请求只指向 loopback 假服务。synthetic .invalid origin 只测凭据状态，不发外部请求 |
| 收尾 | 只清理经 containment 校验的本轮根；恢复 runner 注册表重定向；报告/artifact 只留脱敏布尔值、枚举、计数与哈希 |

C 已有入口是 .github/workflows/e-windows-v040-acceptance.yml，脚本是 packages/desktop/scripts/e-windows-v040-acceptance.mjs。workflow_dispatch 有两种互斥来源：

1. **未发布候选 workflow artifact**：hosted_update=false，提供候选 Release workflow run、siteindex-win artifact ID/digest、候选 source commit 和冻结的验收代码 commit。脚本校验 artifact provenance 与安装 EXE。
2. **已发布候选 Release**：hosted_update=true，提供候选 tag commit、Release asset ID 与 GitHub SHA256 digest。此方式只读已存在资产，不执行发布；不得同时传 URL 或 workflow artifact 参数。

两种方式都以 pinned v0.4.0 NSIS 安装包为升级基线。C 需在启动前确认候选来源、完整 commit、EXE SHA256 和 workflow 输入。当前没有本轮候选包，所以不触发 workflow。

## 候选验收矩阵

| ID | 覆盖 | 当前依赖 / 就绪度 | 已可自动化 | 必须人工验证 |
|---|---|---|---|---|
| PKG-NSIS-UPGRADE | NSIS 安装、v0.4.0 升级、版本和项目/设置保留 | C hosted workflow 已有隔离安装/升级流程；等待候选 pin | 哈希/provenance、安装/升级/重启、运行路径、版本、项目与数据摘要 | 仅在 Playwright 无法确认完整 UI 时查看 hosted VM；不看用户窗口 |
| PKG-STORAGE-READONLY | 旧布局读取、已知同步目录只读 | A #485 已合并；UI 警告依赖 B #484 | 写门禁、错误码、全目录前后哈希、设置/任务摘要 | #484 进候选后检查警告与只读控件文案 |
| PKG-STOCK-ABSENT-STATES | feed 缺席后 removed、out_of_stock、in_stock+feed_anomaly；另测 unknown | Core/CLI #417、#464 已合并；候选 IPC/page 待验 | 虚构 daily、JSONL、固定路由计数、Playwright 页面与 CLI 对照 | 仅当 DOM/无障碍树无法确认状态时人工复核 |
| PKG-MEDIA-RECOVERY | 权限失败、部分成功、保存后断连、重启恢复、查重去重 | #439/#471/#459/#466 已合并；当前 C hosted workflow 是 win-unpacked，不是 NSIS | fixture、Core、win-unpacked hosted harness | NSIS 通过需 C 将 production-gated harness 接到已安装 EXE；接好前未验证 |
| PKG-EDM-SAVEAS-CANCEL | SKU 清单另存与取消不写 | A #473 `renderIndex` 已合并；C #481 Desktop Save As 尚开放；合并后还需独立 contract PR 清除 `PENDING_HANDLERS` | golden 可检查；依赖合并后由 Windows UI Automation 操作原生对话框 | Playwright DOM 不控制原生 Save As；用 hosted UI Automation 或 hosted VM |
| PKG-EDM-CONFLICT | 项目内目标与项目外同/异内容目标的 no-clobber 行为 | A #473 `renderIndex` 已合并；C #481 Desktop no-clobber 尚开放；之后由独立 contract PR 清 pending；D #487 冲突提示已合并 | fixture 完整性；依赖合并后比对目标前后哈希、结果枚举与错误码 | hosted UI 核对提示与不覆盖；不得确认覆盖 |
| PKG-CREDENTIAL-ISOLATION | 假凭据隔离、跨重启、origin 隔离、脱敏 | C hosted oracle #463 已合并；等待候选 provenance | 现有 hosted Playwright、canary 扫描、报告 oracle | 只复核脱敏结果和界面掩码，不公开 canary |

## 逐项步骤与标准

### PKG-NSIS-UPGRADE

1. 用 C 的 workflow_dispatch 下载并核验固定 baseline 与候选来源，记录 tag、commit、SHA256、Windows build 和 runner image。
2. 在隔离根安装 baseline、启动确认 profile 在根内，再升级到候选并等候应用重启。
3. 通过 preload/Playwright 检查完整 UI、候选版本、活动进程路径、合成项目数量及设置摘要。
4. 通过标准：候选版本成功重启；项目/设置/fixture 文件摘要保持；profile 与清理检查通过。

### PKG-STORAGE-READONLY

1. 从 project-storage-policy-cases.json 与仓库虚构项目 fixture 复制数据到根内，包含 legacy index/site.json 与 workspace _site-index/site.json。
2. 在根内构造 synthetic known-sync root；不连接云盘客户端，不使用操作系统现有同步目录。
3. 记录相对路径清单和逐文件 SHA256，再读取项目列表、summary 和只读视图；写入测试只验证拦截码。
4. 重新核对完整文件树、设置登记与任务摘要。通过标准：字节不变、不自动迁移/修复、不写锁/运行记录/任务；#484 入包后显示明确只读警告。

### PKG-STOCK-ABSENT-STATES

1. 使用 stock-verification-acceptance-cases.json、fake-site-service.mjs 与 fake-services.mjs。
2. 分别返回 404/410、明确缺货、页面仍有货；独立运行每个 daily。
3. 再返回未知文案与 429/5xx，核对旧状态没有被误标 removed。
4. 对照 CLI summary、inventory_latest、事件 JSONL、固定路由计数和页面状态。判据为三种业务状态及 unknown 保护结果都一致。

### PKG-MEDIA-RECOVERY

1. 先自测假 WordPress 服务与恢复向量，这只算 L0。
2. 仅当 C 把 production-gated harness 接到 NSIS 安装进程，才在根内启动假图源/WP 并生成本轮假凭据。
3. 覆盖 401/403 整批停止、发送前单项失败、POST 保存后 422/429/503/断连、重启后按 slug 查找与重试。
4. 通过标准：不确定 POST 结果停批；恢复先 GET、不盲目重发；假媒体与台账各一份；应用侧流量只到 loopback。
5. 当前 c-media-production-e2e.yml 的 win-unpacked 报告单列为 L2-unpacked，不计 NSIS 候选通过。

### PKG-EDM-SAVEAS-CANCEL 与 PKG-EDM-CONFLICT

1. Core 侧由已合并的 A #473 `edm.renderIndex` 提供确定性内容；它只渲染，不创建固定输出文件，也不写入目标文件。Desktop C #481 负责原生 Save As 和 no-clobber 写入，目前仍是开放 PR。
2. 在 C #481 合并并完成后续独立 `contract/*` PR、`edm.exportIndex` 从 `PENDING_HANDLERS` 清除之前，只能检查 golden 与夹具，不能把 SKU 导出标成候选包可测或通过。
3. 依赖就绪后，仅在隔离根操作；准备三个目标类：项目目录内已有目标、项目目录外已有且内容相同的目标、项目目录外已有但内容不同的目标。另准备对话框取消和“对话框观察目标缺失后、写入前被并发创建”的竞态。
4. 预期行为：项目目录内已有目标返回 `EDM_INDEX_CONFLICT`，提示原文件未覆盖且可另选文件名，逐字节保留；项目目录外同内容目标返回 `unchanged` 且不改字节；项目目录外异内容目标返回 `WRITE_FAILED` / `EDM_INDEX_SAFE_REPLACE_UNAVAILABLE`，提示原文件未覆盖且另选文件名，逐字节保留；取消不创建/修改任何文件；竞态创建目标不得被覆盖。对于结果不确定，先读回目标核实，不盲目重试。
5. 原生 Save As 选择/取消由 Windows UI Automation 或 hosted VM 完成；Playwright 只检查网页状态，不能声称操作了原生对话框。证据记录目标位置类别、结果枚举、前后哈希和是否写入，不记录绝对路径、文件名或 SKU。

### PKG-CREDENTIAL-ISOLATION

1. 按 credential-isolation-package-acceptance.md 在 C hosted workflow 配置两个虚构 .invalid origin 并生成随机 canary。
2. configure A/B、退出重启、replace B、重启、delete B、重启；读取状态不能回传凭据。
3. 扫描 DOM、storage、IPC、项目文件、vault 可读文件、日志与 artifact 的 UTF-8、UTF-16LE、Base64 和 Basic Header 编码。
4. 通过 credential-isolation-report-oracle.mjs 汇总；只有 oracle 通过且根清理成功才算该包级 case 通过。

## 运行方法

校验本矩阵字段和覆盖项：

    node --test fixtures/e-v041-loopback/v041-candidate-package-matrix.test.mjs

复跑已有虚构 fixture：

    node --test fixtures/e-v041-loopback/fake-services.test.mjs fixtures/e-v041-loopback/retry-after-persist/fake-media-origin.test.mjs fixtures/e-v041-loopback/credential-isolation-report-oracle.test.mjs fixtures/e-v041-loopback/job-export-acceptance.test.mjs

NSIS 验收在 GitHub Actions 选择 E · Windows packaged acceptance，运行 workflow_dispatch。workflow 字段、candidate pin 和候选来源见上述 workflow；本地 dist:win 或 dev:desktop 不属于正式候选包证据。

## 当前未满足项

- 本轮没有候选安装包 pin，NSIS install/upgrade/credential 尚未运行。
- 旧项目 Core 门禁已合并；打包可见的只读提示等待 B #484。
- 库存 Core/CLI 已有证据；NSIS 的 CLI/UI 联动未运行。
- 媒体 Job/API 已接通；hosted win-unpacked 结果不能代替已安装 NSIS 测试，等待 C 接入。
- SKU 另存/取消/冲突依赖 C #481 Desktop Save As/no-clobber 与其合并后的独立 contract PR 清除 `edm.exportIndex` pending；A #473 `renderIndex` 已合并，不负责写文件。

上述均为未验证或受依赖阻塞，不标记通过/失败。候选包运行后按 case ID 报 passed、failed 或 not-run，并注明 fixture、Core/CLI、win-unpacked、NSIS/Playwright 或 native-dialog 证据层。
