# v0.8.3 / v0.8.4 发布后验收复盘

记录日期：2026-11-26
性质：事后证据整理。不追认未执行的预发布 Gate，不代表当前候选包验收，也不替代 v0.8.5 的 G8.5 Gate。

## v0.8.3

- Release：[v0.8.3](https://github.com/henryliuwork/SiteIndex/releases/tag/v0.8.3)，2026-11-25 发布。
- Tag commit：05f669b2e65d027a2ddadaab53f8c0fe08f0aecb。
- 范围：产品表必显列与列偏好、表头/对齐、产品管理表格呈现，及 UI 检查器与托管安装验收。

| PR | 范围与行为分类 | 三系统 CI |
| --- | --- | --- |
| [#808](https://github.com/henryliuwork/SiteIndex/pull/808) | 精确允许紧凑排序表头与说明图标的扫描尺寸；检查器调整，无产品行为变化。 | [Run 45534729908](https://github.com/henryliuwork/SiteIndex/actions/runs/45534729908) 全绿 |
| [#809](https://github.com/henryliuwork/SiteIndex/pull/809) | 补无说明图标的排序表头检查并保持阈值；检查器调整，无产品行为变化。 | [Run 45536403115](https://github.com/henryliuwork/SiteIndex/actions/runs/45536403115) 全绿 |
| [#810](https://github.com/henryliuwork/SiteIndex/pull/810) | 共享表格从旧缓存补回必显列；列设置成为草稿，保存才生效；支持拖拽/键盘排序、恢复默认、取消；调整对齐和趋势图。用户可见交互变化，特别是保存/取消语义。 | [Run 45537594959](https://github.com/henryliuwork/SiteIndex/actions/runs/45537594959) 全绿；PR 记录 ui:check 108/108 strict |
| [#811](https://github.com/henryliuwork/SiteIndex/pull/811) | 产品管理固定 SKU/名称列，调整名称、状态、数字、链接、操作和趋势列。用户可见页面变化。 | [Run 45540141634](https://github.com/henryliuwork/SiteIndex/actions/runs/45540141634) 全绿；PR 记录 ui:check 108/108 strict |
| [#812](https://github.com/henryliuwork/SiteIndex/pull/812) | Desktop、CLI、本地 MCP 版本号统一到 0.8.3，固定候选并准备发布；无产品行为变化。 | [Run 45544274530](https://github.com/henryliuwork/SiteIndex/actions/runs/45544274530) 全绿 |
| [#813](https://github.com/henryliuwork/SiteIndex/pull/813) | 新增托管 Windows 隔离安装版表格验收工作流；验收基础设施，无产品行为变化。 | [Run 45543196822](https://github.com/henryliuwork/SiteIndex/actions/runs/45543196822) 全绿 |

### 安装版和发布证据

- 固定候选构建：[Release Run 45540953781](https://github.com/henryliuwork/SiteIndex/actions/runs/45540953781)，head 1bf5ee8bc77918ca2b670a28bc89556a7b7de439，Windows artifact ID 14988923468，EXE SHA256 94F689E66E5FECBDA62EB7DCB631DF5412549420E56249CE88F1AB26DBB20100。
- 托管 Windows 隔离安装验收：[Run 45543897424](https://github.com/henryliuwork/SiteIndex/actions/runs/45543897424) 成功。记录涵盖固定候选 SHA、合成旧列状态、打包 UI/IPC 与文件读回、列拖动/保存/取消、正常退出重启、离线字体、表头/链接/趋势及打包 --run-job views。125%/150% 是 CDP 模拟缩放，不是 Windows 系统 DPI 实测。
- PR #812 说明验收候选来自较早固定 head；最终版本提交只同步版本字符串，产品与打包输入保持一致。随后 [main CI Run 45544833254](https://github.com/henryliuwork/SiteIndex/actions/runs/45544833254) 与 [tag Release Run 45545495545](https://github.com/henryliuwork/SiteIndex/actions/runs/45545495545) 成功，tag 指向上述 commit。
- 边界：这是托管 Windows、隔离合成数据的候选包局部实测；只证明所列用例，不证明用户机器、Windows 原生 DPI 或完整版本矩阵。不得表述为整个版本完整 E Gate 通过。

## v0.8.4

- Release：[v0.8.4](https://github.com/henryliuwork/SiteIndex/releases/tag/v0.8.4)，2026-11-25 发布。
- Tag commit：fdf486f9e1a209f525783062c2644cd3401763e7。
- 范围：执行设备名称与无 Feed 跳过原因可见性、跳过历史兜底文案、全局提示/布局、定时任务表格，以及固定版本候选包验收。

| PR | 范围与行为分类 | 三系统 CI |
| --- | --- | --- |
| [#814](https://github.com/henryliuwork/SiteIndex/pull/814) | 当前执行设备改名后摘要/状态显示新名称；daily 跳过记录落盘原因。Core 行为变化。 | [Run 45563975560](https://github.com/henryliuwork/SiteIndex/actions/runs/45563975560) 全绿 |
| [#815](https://github.com/henryliuwork/SiteIndex/pull/815) | 无明细的 skipped 历史显示“任务已跳过”，有原因时优先展示原因。UI 兜底文案变化。 | [Run 45571982977](https://github.com/henryliuwork/SiteIndex/actions/runs/45571982977) 全绿 |
| [#816](https://github.com/henryliuwork/SiteIndex/pull/816) | 统一提示图标、全局页框架/留白、定时任务表格；KPI 整卡交互与显式关闭分页表格。用户可见 UI/交互变化。 | [Run 45571163252](https://github.com/henryliuwork/SiteIndex/actions/runs/45571163252) 全绿；PR 记录 ui:check 108/108 strict |
| [#817](https://github.com/henryliuwork/SiteIndex/pull/817) | Desktop、CLI、本地 MCP 版本号统一到 0.8.4；参数化固定包验收并增加隔离工作流。版本与验收基础设施变化，无产品行为变化。 | [Run 45575578907](https://github.com/henryliuwork/SiteIndex/actions/runs/45575578907) 全绿 |

### 安装版和发布证据

- 合并后 [main CI Run 45576454471](https://github.com/henryliuwork/SiteIndex/actions/runs/45576454471) 成功，Windows/macOS/Ubuntu 均通过；包含 typecheck、全量测试及 Windows Desktop 构建检查。
- [Release Run 45577171330](https://github.com/henryliuwork/SiteIndex/actions/runs/45577171330) 成功；Windows/macOS 包构建和草稿 Release 资产核验通过。
- 固定候选包托管 Windows 隔离验收 [Run 45577865996](https://github.com/henryliuwork/SiteIndex/actions/runs/45577865996) 成功。日志记录 EXE SHA256 20b17cb1c3e6f813df93b8fda2ad6ab1aaa3fb6f31641dcd73df9d88c6a4d7d6；结果 artifact ID 15004648327；packaged UI 与 --run-job 用例通过，使用隔离 profile 和合成数据。
- [v0.8.4 收尾记录 #819](https://github.com/henryliuwork/SiteIndex/issues/819) 明确该版没有事前看板与计划文档。因此这些是发布后整理与托管隔离候选包检查，不能追认为预定义的完整 Gate，也不是用户本机安装验收。

## 总结

1. v0.8.3 有固定候选 Windows 安装版局部证据，范围是表格与列设置，不代表全部需求已验收。
2. v0.8.4 有三系统 CI、发布资产验证与固定候选 Windows 隔离验收；保持事后证据口径。
3. 不关闭历史 Issue，不将未测项记为通过。v0.8.5 E-2 等 G8.5-2 后按路线图独立执行；旧验收脚本保留至新工作流全量通过。
