# SiteIndex v0.4.1 · E 合成验收矩阵

## 基线与边界

依据 `docs/plan/2026-11-05-v040-roadmap.md` §4.5、§4.6、§5 E，以及已合并 K5 契约 PR [#390](https://github.com/henryliuwork/SiteIndex/pull/390)（合并提交 `b73b3a0`）。K5 规定了 `media.prepare`、401/403 停批语义、`feed_anomaly`、旧版 `sku_media` 台账扩列和敏感凭据边界；这些契约本身不证明 Core、CLI、Desktop 或 UI 行为已实现。

本矩阵只使用 `synthetic-shop.test`、`SYN-*` 虚构 SKU、内存中的假媒体和 loopback 服务。服务只能绑定 `127.0.0.1`，不记录请求头或请求正文，不访问真实站点，不上传真实媒体，不迁移真实项目，也不安装应用。

截至验收准备时，`main` 基线为 `dab4db0efd4fb384cadb502d5d6b372a0ced7c99`。`media.prepare` 仍列在 `PENDING_HANDLERS`，EDM 页明确将图片处理标为演示且禁用；`edm export-index` 尚无 CLI 命令。库存核验只在开放 PR #417 分支验证，不能记作 main 或安装包通过。

## 证据层级

| 层 | 能证明什么 | 不能证明什么 |
|---|---|---|
| L0 Loopback 夹具自测 | 假 GraphQL / WordPress 服务的状态响应、汇总请求计数、上传持久化后断连、假凭据扫描器 | SiteIndex 是否正确调用服务、Job/IPC/UI 是否正确 |
| L1 Core / CLI 源码验收 | 固定提交上的 Core/CLI 代码对虚构项目和 loopback 响应的行为 | 安装包、Desktop IPC、页面、真实 WordPress 权限 |
| L2 打包 IPC / 页面 | 正式候选包的凭据保存/清除、错误码、Job 进度、EDM 页面逐 SKU 结果 | 真实站点的安全插件、CDN 或账号行为 |
| L3 真实测试环境 | 用户授权的测试 WordPress 账号和虚构媒体上的端到端结果 | 本轮不执行；需要单独授权和候选包 |

## 验收项

| ID | 覆盖项与虚构输入 | 步骤 | 通过标准 | 证据层与当前状态 |
|---|---|---|---|---|
| INV-01 | Feed 缺席但页面 / GraphQL 有货；另含缺货、预售 | 以完整非空 Feed 跑 daily；仅核验 active 且缺席 SKU | 有货 SKU 保持 active、库存变为 `in_stock`，生成一条 `feed_anomaly` 库存事件与 summary 项；不写 SEO issue。缺货 / 预售按配置更新 | L1：#417 `23c35c7` Core 测试 11/11 通过，覆盖 GraphQL 业务结果；不是 main/安装包证据 |
| INV-02 | 产品页 5xx、GraphQL 429、损坏响应、未知文案 | daily 对旧库存为有货及缺货的 SKU 分别返回不可用 | 原 `stock_status`、`since`、`checked_at` 保持；Job 标 `partial` 并报告不可用数；不误标 removed | L1：#417 Core 测试覆盖相近错误路径；精确的三轮恢复清单尚未独立执行 |
| INV-03 | 产品页 404 / 410 | 对当前 Feed 缺席 SKU 分别返回 404、410 | 只移除对应 SKU，`removed_reason=feed_absent_404`，删除其最新库存行，每 SKU 一条移除事件；不得再发 GraphQL 请求 | L1：#417 Core 测试已覆盖；安装包未测 |
| INV-04 | 两条以上候选、每轮上限 1 或 2；中途有 SKU 加入 / 回到 Feed | 每轮显式传入 `date` 与 UTC `now`；用 `inventory_latest.checked_at` 变化得到无序访问集合，再读取游标 `last_sku` | 每轮不超过上限；已回到 Feed 的 SKU 不再请求；精确访问集合加 `last_sku` 可推出每轮顺序；候选集合变动后没有饥饿 | L1：#417 Core 测试 11/11 覆盖轮转、候选变化；无 per-SKU 请求正文记录。测试是函数重跑，不是 OS 进程重启 |
| INV-05 | 事件、`inventory_latest`、SKU catalog、daily summary 四个输出目标逐一注入写入失败 | 逐个将 one-shot `atomicWrite` 故障注入目标；保留事务清单 / 备份后再次调用并切到 5xx | 重试先恢复同一批次所有目标；待处理游标不提前提交；重跑报告不可用且不产生错误下架或重复事件 | L1：#417 `23c35c7` Core 测试逐一注入四个输出故障，随后同进程重跑；未模拟子进程被杀 |
| INV-06 | 空 / 损坏恢复清单、指向任意项目文件的路径、缺失备份、恢复期间外部编辑目标文件 | 分别启动恢复逻辑并核查原件和恢复材料 | 必须 fail closed；不得清理唯一备份或清单，不得写入清单允许范围之外的文件，不得静默覆盖外部编辑 | L1：`23c35c7` 尚未覆盖；开发复审指出这四个门槛，A 正修复。该提交不得记为最终通过 |
| MED-01 | 假 WordPress 当前用户接口：401 与 403；批次含前置成功和未开始 SKU | GET 当前用户能力，再提交多 SKU 媒体 Job | 401 为 `WP_AUTH_FAILED`、403 为 `WP_FORBIDDEN`；立即停批；保留先前成功项，未开始 SKU 保持未决；错误文案不含认证响应或凭据 | L0：假服务支持且自测；L1/L2：媒体 Job 与 handler 未接通，未验证 |
| MED-02 | 一批 SKU 中分别配置成功、单 SKU 5xx / 429 和后续成功 | 运行批次并检查逐 SKU 结果与汇总 | 普通单 SKU 失败不阻断其他 SKU；总状态为 `partial`；每个已处理 SKU 恰有一条结果。401/403 则按 MED-01 停批 | L0：服务能配置混合结果；产品批次逻辑未验证 |
| MED-03 | 假上传端保存媒体对象后断开连接，下一次 GET slug 查重命中 | 第一次上传后模拟连接断开；重试同一 SKU、同源图指纹 | 重试复用已存在对象（`reused`），只保留一个假媒体对象、一次成功上传记录和一条台账行；`media_id` / `source_hash` 稳定 | L0：假服务已覆盖“保存后断连”和后续 GET 查重；SiteIndex 客户端是否先查重未验证 |
| LED-01 | 旧版 8 列 `sku_media.csv` 与两条虚构旧记录 | 先只读导入；再触发第一次真实写入 | 读取 / 导入时文件字节不变；首次写入才将 `media_id,source_hash` 追加为第 9、10 列，保留旧列和旧值，旧行新增列留空 | L1：#390 契约与 shared contract tests 约束表头；Core 文件迁移尚无验收证据 |
| SEC-01 | 只在测试进程使用的假凭据 canary | 将假值投放到模拟凭据源并扫描模拟日志、Job、IPC、CLI/MCP 与导出边界 | 公开输出不包含假值；扫描器只返回匹配类别 / 数量，不返回命中内容。另核验错误码、提示及结果不回显响应正文 | L0：假 canary 扫描器自测；产品日志/IPC/CLI/MCP 尚未逐层验证 |
| EXP-01 | 虚构父子 SKU、synthetic 价格等级、tag、jpg/png/webp 与空图台账 | 调用 `edm export-index`，检查生成的 SKU 清单 | 按父 SKU 聚合；图片选择台账主图优先，其次 feed 首图；只输出 jpg/png；无图标记待补图；应用折扣档并写出短描述；不得输出凭据 | L1：导出命令尚未实现，准备项；L2 页面不可替代 CLI 导出证据 |

## 可观察性与 GraphQL epoch 切换

伪 GraphQL fixture 的响应配置不可变，快照不保存请求 SKU 或请求正文。访问集合从每轮前后的 `inventory_latest.checked_at` / 状态变化推导；顺序由集合加 `stock-verification-cursor.json` 的 `last_sku` 确认。候选 cap 为 2 且集合恰有两个 SKU，因此集合中的另一个 SKU 必为先访问项。每轮 `date` 和 `now` 都固定为 UTC；不得仅用 `options.date` 推断 `checked_at`。

第六例在 Core 测试夹具里用一次性 `atomicWrite` 故障点制造事件文件已写、`inventory_latest` 写入失败；每个 GraphQL epoch 单独启一个 loopback 服务。每轮结束先 `close()` 旧服务，再用该 epoch 的 `responsesBySku` 新建服务，把新 endpoint 写入同一虚构项目的 `site.json`，然后重新执行 daily。项目台账、恢复清单与游标保持同一份，只有假服务 endpoint 变动。

## 已有测试记录与限制

- Loopback 假服务自测 `node --test fixtures/e-v041-loopback/fake-services.test.mjs`：7/7；仅证明 L0 服务夹具的计数、401/403、429、保存后断连、混合结果与假 canary 扫描。
- K5 `packages/shared/test/media-contract.test.ts`：在基线 `dab4db0efd4fb384cadb502d5d6b372a0ced7c99` 上 8/8；只证明契约，不证明台账文件迁移或媒体处理。
- #417 固定提交 `23c35c76c59f7dbcc469bfbd672ae8f1fd808428`：Core `stock-verification.test.ts` 11/11；CLI `cli.test.ts` 8/8；临时 CLI `main()` loopback 日更调用 1/1。CLI 专项调用读取假 Feed 和假 GraphQL 并检查 `feed_anomaly` 输出，但不是打包 CLI，也未做子进程崩溃恢复。
- #417 目前仍是开放 PR。23c 的事务恢复清单还有 INV-06 四项完整性 / 并发编辑门槛未验证；不得把其 Core 通过数写成 PR 最终通过或发布验收。
- L2 正式候选包和 L3 真实 WordPress 环境均未执行。所有未实现或未接线的 API/UI 维持“未验证”，不得用 mock 自测替代。
