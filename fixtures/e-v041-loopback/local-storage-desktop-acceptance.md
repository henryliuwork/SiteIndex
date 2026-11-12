# 本机存储保护 · 桌面验收准备

## 产品边界

SiteIndex 当前只支持本机项目数据，不提供云盘同步或跨设备同步。每台设备（以及每个独立 Windows 用户 profile）的项目登记、应用设置和本地缓存分别保存；在 A 设备新建或修改的状态不会自动出现在 B 设备。产品不负责将云盘项目迁移到本机。需要迁移时，由用户先手动复制项目文件夹到目标设备的本机目录，再按 UI 说明取消旧登记并添加本机副本。

路径识别是保守、尽力而为的：明确识别到的已知同步根显示 `known_cloud_sync` 并阻止写入；未识别的路径仍为 `unknown`，不得把它表述成已确认本机。不能据此声称所有任意挂载、用户配置的同步路径都能识别。

## 前置条件

- v0.4.1 候选 EXE、来源 commit、SHA256 和 Windows runner image 已固定；升级基线仍为 pinned v0.4.0 NSIS。
- A #485 Core/CLI 本机存储写保护已合并。桌面 UI 验收必须等 B #484 合入候选；它负责项目中心、新建向导说明、只读标记和入口可用性。
- 在 GitHub-hosted Windows 上使用两个独立 job/VM，每个都是干净 runner；禁止在用户电脑、现有 profile、真实同步目录或真实项目上运行。
- 两边分别在各自 `RUNNER_TEMP` 建立唯一根，重定向 `APPDATA`、`LOCALAPPDATA`、`USERPROFILE`、`HOME`、`TEMP`、`TMP`；生成的项目、设置、截图、日志和报告都放在各自隔离根内。
- 只用 `project-storage-policy-cases.json` 生成虚构的已知同步路径、前缀相似兄弟目录和未配置第三方路径。不启动 OneDrive/Dropbox/其他云盘客户端，不访问云服务。

## 用例 S1：已知同步目录只读保护

1. 在 runner A 的隔离根内创建虚构同步根和 fixture 项目；向环境变量或 runner 配置注入只指向该根的识别信息。项目内容只使用合成 `site.json`、少量 JSONL 和可识别的哨兵文件。
2. 用 v0.4.1 安装包添加/打开已登记项目，记录项目中心卡片、项目页标题区的存储标记、警告文字和各写入入口状态。
3. 只读打开 summary、库存、运行历史和设置。逐文件记录路径相对层级、文件数及 SHA256 摘要；不得复制原始文件内容进报告。
4. 对新建配置、保存设置、同步、锁、计划任务和运行记录入口发起会被阻止的操作；仅记录结果枚举/错误码，不修改数据。确认同步、Feed 配置、工作区导入检查、待处理提醒状态写入入口按 #484 设计隐藏或禁用。
5. 使用前缀相似兄弟目录和未配置第三方路径作负例。预期分类为 `unknown`，UI 不得声称“已验证本机”；若产品对 unknown 仍允许本机操作，记录其状态，不把它错判为 known cloud。
6. 如验收显式移除项目，确认只取消项目登记、目录仍存在且逐文件哈希完全相同；不要选择任何删除文件选项。

通过标准：known-cloud 项目可读，写操作被 `PROJECT_CLOUD_SYNC_UNSUPPORTED` 拦截，已有数据、设置、任务、锁和运行文件不变；界面说明当前版本仅支持本机存储。项目移除只取消登记，不删除项目数据。前缀相似路径不会被误判；unknown 不会被宣传为已验证本机。

## 用例 S2：设备数据独立

1. 在两个独立 Windows hosted job/VM 使用相同候选 EXE 和验收脚本。A、B 使用互不相交的 profile 根和项目根；禁止复用 profile、runner cache、注册表重定向、共享盘或云同步目录。
2. A 中添加虚构项目 `SYN-DEVICE-A` 并变更一项无敏感值的 fixture 设置；启动 B 时保持空项目列表和默认设置。只记录 `project_count`、项目状态枚举和设置字段类别，不记录项目名、路径或设置原值。
3. 完全退出、重启各自应用后分别读取 `projects.list()` 与设置摘要。A 应保留自己的本机项目/设置；B 应保持空列表/默认状态。
4. 在 B 创建 `SYN-DEVICE-B` 并改另一项虚构设置，再重启并读取 A；A 的项目/设置摘要不得改变。全程禁止手动复制项目，避免将复制行为误认为产品同步。
5. 只开放 loopback fixture 网络。对报告、进程参数、日志和 UI 做脱敏扫描，确认无真实 URL、路径、用户信息或凭据；记录两边容器化/隔离根清理结果。

通过标准：A/B 均能在本机 profile 内重启读回自己的状态；对方状态不会自动共享、出现或改变；应用没有显示云盘同步可用或“跨设备实时同步”文案。该结果只证明独立 runner/profile 下本地状态隔离，不证明真实云盘、真实网络隔离产品或任意两台物理设备上的用户操作。

## 汇报字段

| runner | 候选 commit / EXE SHA256 | Windows image | profile containment | 项目数 | 设置状态枚举 | known-cloud 写保护 | tree hash unchanged | 脱敏扫描 | 清理 |
|---|---|---|---|---:|---|---|---|---|---|
| A | 仅记录完整候选 provenance | 记录 runner image 标签 | pass/fail | 计数 | enum | pass/fail/not-run | pass/fail | 类别计数 | pass/fail |
| B | 与 A 相同 | 记录 runner image 标签 | pass/fail | 计数 | enum | pass/fail/not-run | pass/fail | 类别计数 | pass/fail |

若 #484 尚未进入候选包、candidate provenance 缺失、任一 profile 越出隔离根或清理失败，则对应桌面验收标记 `未验证` / `失败`，不可用 Core 测试或 UI mock 替代安装包结果。
