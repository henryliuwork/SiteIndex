# SiteIndex

独立站数据索引 —— 本地桌面软件（Windows 为主，兼容 macOS）。抓取并维护网站数据，告诉 agent 如何使用这些数据。

每个独立站 = 一台设备本机上的标准化项目文件夹：

```
example-project/
├── README.md            给 agent 的项目说明（自动区块由软件维护）
├── index/               站点数据：SKU、库存、SEO、博客、台账、视图、日志
├── _agent/skills/       标准化 skill：各场景如何读取与使用 index/ 数据
└── …                    你自己的工作目录（软件不管理）
```

## 项目存储

SiteIndex 当前支持每台设备各自使用本机、非同步目录中的独立项目副本；不支持通过 OneDrive、Dropbox、Google Drive、Box、Nextcloud、iCloud Drive 等同步同一项目。软件能识别到的同步目录中的旧项目仍可只读查看，但不能在其中运行会写入数据的操作。需要继续使用时，请在文件管理器中手动复制整个项目文件夹到本机非同步目录，再添加复制后的项目；SiteIndex 不会自动搬迁、删除或同步项目文件。

云目录识别只是尽力而为。未识别到同步位置不代表该目录已经验证为本机存储；请选择并确认一个不会被同步软件管理的本机目录。每台设备应有独立项目副本，不要让多台设备通过文件同步同时读写同一份项目数据。

软件负责确定性的数据工作：GMC feed 与 sitemap 抓取、库存变化与在线率、SEO 页面与问题、Google 收录检查、数据校验与修复、README 维护、系统定时任务。Claude Code / Codex / qwenpaw / Qoder 等 agent 打开项目文件夹，读 README 后完成内容工作（EDM、博客、内链、页面设计）。

## 状态
MVP 开发中（v0.1）。三个工作流并行开发，见 [docs/WORKSTREAMS.md](docs/WORKSTREAMS.md)。

## 文档
- [产品需求 PRD](docs/PRD.md)
- [技术架构](docs/ARCHITECTURE.md)
- [数据规范](docs/DATA_SPEC.md)
- [界面设计规范](docs/DESIGN.md) · [界面画板](design/README.md)
- [开发分工](docs/WORKSTREAMS.md) · 任务：[A Core](docs/tasks/A-core.md) · [B UI](docs/tasks/B-ui.md) · [C Desktop](docs/tasks/C-desktop.md)

## 开发
需要 Node ≥ 20 与 pnpm 10。
```bash
pnpm install
pnpm typecheck && pnpm test
pnpm dev:ui        # 浏览器中预览界面（mock 数据）
```

## 安装（发布后）
从 Releases 下载：Windows `SiteIndex-Setup-x.y.z.exe`；macOS `SiteIndex-x.y.z-universal.dmg`。
初期安装包未签名：Windows 出现 SmartScreen 时点"更多信息 → 仍要运行"；macOS 首次打开请右键 → 打开。
