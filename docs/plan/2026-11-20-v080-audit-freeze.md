# SiteIndex v0.8.0 · W0 小样式审计冻结清单

冻结时间：2026-11-20。基线：`main` `83e5fefc467167f9b7fec40a4916c88c2fdf19b6`。本清单只处理 [v0.8.0 roadmap §4](2026-11-20-v080-ui-frame-spec-roadmap.md) 所说的「其余小样式问题」；lead 已合并 B、D、E 的一次性审计并去重。

## 审计来源

- [B 的共享层与全局页量测及截图](https://github.com/henryliuwork/SiteIndex/issues/694#issuecomment-7035071950)：8 项现状差异；[B 的归属更正](https://github.com/henryliuwork/SiteIndex/issues/694#issuecomment-7035097512)确认均属于既定任务。
- [D 的项目页量测及截图](https://github.com/henryliuwork/SiteIndex/issues/694#issuecomment-7034900047)：6 项页面差异和 1 项共享项目头差异；[DataTable 滚动口径](https://github.com/henryliuwork/SiteIndex/issues/694#issuecomment-7034925733)已由 lead 判定。
- [E 的 Windows 100% 旧字体栈与页面量测](https://github.com/henryliuwork/SiteIndex/issues/694#issuecomment-7034944792)：7 项现状差异，与 B/D 的共享头、全局外框、滚动、SKU 列和控件尺寸重叠。125%/150% 系统缩放及新字体对照仍是 G8.0-0 待补证据，不属于小样式条目。

## 去重与归属

| 已确认的现状差异 | 既定交付任务 |
|---|---|
| 全局标题行、项目头、侧栏两行、页头按钮、工具栏尺寸与间距 | B-1、B-2 |
| 项目页内容起点、私有视口高度与负边距、DataTable 页滚动 | B-1、D-1；全局 `SchedulesPage` 由 B-2 迁移 |
| 产品管理及变体表的独立 SKU 首列 | D-2 |
| 设计页 HEX/RGB 与按钮空态 | D-3 |

这些是 roadmap §3 的原定功能交付与 Gate 基线，不再开重复的 §4 修复 PR。

## 冻结结果

**其余小样式问题：0 条**（上限 20 条）。本次冻结后发现的可测量小样式问题按 roadmap §4 进入 backlog，不追加到本清单；R/D/B 范围内缺陷仍按 lead playbook §5 单独处理。此记录不表示 B-1～D-3 已通过，也不替代字体对照或安装包验收。
