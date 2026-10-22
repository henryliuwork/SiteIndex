# SiteIndex

独立站运营数据工作区 —— 本地桌面软件（Windows 为主，兼容 macOS）。

每个独立站 = 云盘中的一个标准化项目文件夹：

```
kingsyard/
├── README.md            给 agent 的项目说明（自动区块由软件维护）
├── index/               站点数据：SKU、库存、SEO、博客、台账、视图、日志
├── _agent/skills/       标准化 skill（EDM、博客、库存报告…）
└── seo/ edm/ 产品/ 内容/ 设计/ 报告/   工作区文件夹（每个带 _about.md 说明）
```

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
