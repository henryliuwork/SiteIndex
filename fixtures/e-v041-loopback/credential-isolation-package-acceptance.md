# v0.4.1 · 正式候选包凭据隔离验收

## 范围与入口

此清单用于正式 Windows 候选安装包的隔离验收。它只使用 GitHub-hosted Windows runner、`RUNNER_TEMP` 下新建的测试根、两个保留 `.invalid` 域名、虚构项目和运行时生成的假凭据。不得指向用户本机已有 profile、项目或凭据；不得访问真实服务。

C 当前维护的候选包入口为 `.github/workflows/e-windows-v040-acceptance.yml`，执行脚本为 `packages/desktop/scripts/e-windows-v040-acceptance.mjs`。运行前由 C 确认候选安装包来源、版本、commit 和 SHA256，并确认该 workflow 是本轮应使用的入口。该入口要求 GitHub-hosted Windows runner；本清单和本次夹具测试不触发安装。

## 前置证据

- 正式候选 tag、tag commit、Windows EXE SHA256、workflow run、artifact ID 与 artifact SHA256。
- Windows 版本/build 与 runner image。
- 安装包真实安装目标、安装 EXE、CDP renderer、preload IPC 与 main/utility process 都来自隔离测试根。
- 两个测试项目只含虚构配置；凭据仅为本轮生成的 canary；两个站点 origin 均使用 `.invalid`。

任一来源、版本或哈希不一致，立即判失败，不继续凭据操作。

## 操作顺序

1. 在 `RUNNER_TEMP` 下创建唯一隔离根。设置 `APPDATA`、`LOCALAPPDATA`、`USERPROFILE`、`HOME`、`TEMP`、`TMP` 到根内独立目录；在根内建立项目目录、LocalCredentials vault 目录和安装目录。重定向 Windows Roaming AppData 后，先保存原注册表值，退出前恢复。
2. 对六个实际进程环境变量、Electron 的 `appData/userData/home/temp`、项目目录、vault、安装目录及活动 SiteIndex EXE，逐项做 canonical `realpath` containment 和逐级 `lstat` reparse-point 检查。打包进程和 preload 的 profile 诊断必须报告完整路径键集；路径本身不写入 artifact。项目中心必须从隔离项目根发现两个虚构项目，vault 必须来自隔离 `LOCALAPPDATA` 下的 LocalCredentials 目录。
3. 用两个不同的 `.invalid` origin 分别保存 canary 凭据；替换第二个 origin 的凭据；删除第二个 origin 的凭据。每个操作只从打包 UI 经 preload/IPC 执行。确认 renderer 文本与浏览器存储没有 canary，IPC trace 只含方法名和次数。
4. 完成 A/B 配置后完全退出并重启同一安装版与同一隔离 profile，再读取两站点状态；替换 B 后重启并读回；删除 B 后再次重启并读回。预期：配置后 A/B 均 configured；替换 B 后 A/B 仍 configured；删除 B 后 B 为 not_configured、A 仍 configured；最后清理 A。每次预期重启确认旧进程退出，PID 与 renderer `performance.timeOrigin` 均变化。
5. 应用退出后扫描隔离 profile、vault、项目、临时目录、进程输出和最终 artifact 中的 canary 明文、UTF-16LE、Base64 及 Basic Authorization 形式。扫描同时拒绝 reparse 条目。报告只留下文件数、匹配类别/计数和状态，不保留原始日志、路径、用户名、应用密码或 Basic token。
6. 恢复 runner 原有 AppData 注册表值；再次验证隔离根仍位于 `RUNNER_TEMP` 且无 reparse point，然后只清理该隔离根。清理后断言根不存在、安装进程不存在。

## 通过标准

- 六个环境路径键全部存在；每项 `withinRoot=true`、`noReparse=true`。
- 打包 renderer/preload 和主进程/utility 子进程均实际报告 10 个路径观测项：`appData`、`userData`、`home`、`temp` 与六个环境变量。所有观测均在隔离根内且无 reparse point。
- 项目根、vault 根、安装目录、安装 EXE 和活动 SiteIndex 进程 EXE 均在隔离根内；两个虚构项目由安装版发现；凭据经安装版配置后在同一隔离 profile 重启读回。
- A/B 配置隔离正确；替换/删除 B 不影响 A；每次预期重启都验证为新进程、新 renderer。
- renderer、浏览器存储、IPC 返回、进程输出、项目目录、vault、隔离临时目录及 artifact 的 canary 匹配数均为 0；所有必扫根可读，扫描完成标志为真。
- Junction/reparse 逃逸探针被拒绝，探针目标与 junction 清理都确认完成；AppData 注册表恢复成功；隔离根、安装版进程无残留。

## 失败标准与证据

缺失路径键、路径逃出根、canonical path 不符、任一 reparse point、vault/项目路径无法证明、状态无法跨重启读回、A/B 串扰、密码回显、canary 命中、扫描不可读/未完成、registry 未恢复或残留均判失败。报告只记录失败阶段 code、布尔值和计数；真实路径或任何凭据值均不得进入公开 Issue、日志或 artifact。

## 夹具 oracle

`credential-isolation-report-oracle.mjs` 对脱敏后的运行摘要做结构与通过条件核验；`credential-isolation-report-oracle.test.mjs` 使用完全虚构的摘要验证成功、缺路径/reparse、重启状态缺失和 canary 泄漏会被拒绝。它不调用 Electron、SiteIndex API、安装程序或真实文件系统，也不把夹具结果称为安装包验收。
