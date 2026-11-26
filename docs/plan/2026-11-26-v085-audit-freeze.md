# v0.8.5 W0 UI 审计与冻结候选

状态：**待 Lead 确认；确认前不视为冻结**。

审计日期：2026-11-26

审计代码 head：`60082cf`
规范 PR 提交基线：`origin/main` `e936f9b`。Lead 已确认其间合并的 #823 只改 shared 类型、不影响 UI 审计结果；#822 更新发布准入文档。

## 审计范围与结果

- 27 个路由 × 4 个视口，共 **108** 次路由/视口检查；均运行严格外框断言。
- 视口：1280×800@1、1920×1080@1、1536×864@1.25、1280×720@1.5。
- 样式扫描：**0 新违规、0 基线条目**；时间重复告警 **0**；控制台错误 **0**。
- 严格外框检查：108；旧外框检查：0。
- 新视口直接失败 **3 项**，详见下表。SEO 的可见行数为 8（目标 9），但标记为已有 section-page legacy baseline，不计入新失败。
- `packages/ui/visual/spacing-exceptions.json` 实际登记 **4 条**，路线图 §3.1 写 5 条；此次按仓库现状审计，没有虚构第五条。108 次检查共命中已登记 exception **532 次**，未形成新样式失败或 spacing baseline 条目。

## 冻结候选（共 6 条，确认后不得追加）

| # | 优先级 | 路由 / 组件 | 证据与对应规则 | 归属 | 后续处理建议 |
|---|---|---|---|---|---|
| 1 | P1 | 项目中心 `/`，1280×720@1.5 | `.si-table-scroll` 底边为 722px，视口高 720px；触发 `frame-table-scroll`。截图：`packages/ui/.shots-v085-audit/project-center-1280x720@1.5.png` | B | 调整项目中心表格区高度，使外框内容不溢出。 |
| 2 | P1 | 系统计划任务 `/schedules`，1280×720@1.5 | 分页底边为 734px，超出视口 14px；触发 `table-pagination-viewport`。截图：`packages/ui/.shots-v085-audit/schedules-system-1280x720@1.5.png` | B | 紧凑系统任务区，确保主表分页完整可见。 |
| 3 | P1 | EDM `/p/demo/edm`，1280×720@1.5 | 首屏可见行数 8，目标 9；触发 `section-visible-rows`。截图：`packages/ui/.shots-v085-audit/edm-1280x720@1.5.png` | D | 由 D 调整页面纵向占用；B 不修改页面实现。 |
| 4 | P2 | DataTable 可排序表头按钮 | S2 `table-heading-controls-zero-padding` 共 212 次命中；该 exception 未由组件尺寸契约要求保留。 | B 共享层 | 修复共享表头控件内边距，并删除对应 exception。 |
| 5 | P2 | InfoTooltip 精确命中区 | S1 `info-tooltip-20px` 与 S2 `info-tooltip-zero-padding` 各 156 次命中；20×20px 是正式尺寸要求。 | B 共享层 | 将精确组件规则纳入检查器后删除两条 exception，不放宽命中区规范。 |
| 6 | P2 | DataTable 表头说明与排序控件 | S3 `table-header-help-4px` 共 8 次命中；4px 间距已成为正式组件规则。 | B 共享层 | 将具名组合规则纳入检查器后删除 exception，不扩大到其他控件间距。 |

以上冻结候选共 **6 条**，低于最多 15 条。未列入的样式偏好、其他视口新发现或新页面问题进入 backlog，不在本次冻结后追加。

## 既有基线与 exception 清点

SEO `/p/demo/seo` 在 1280×720@1.5 下可见行数为 8，目标 9，检查结果 `legacy=true`；这是现有 section-page baseline 项，仍保留现状，不通过本次审计新增或放宽基线。

实际登记的 4 条 spacing exception：

| exception id | 规则 | 命中次数 | 处理 |
|---|---|---:|---|
| `table-header-help-4px` | S3 | 8 | 正式规则已写入 DESIGN；后续内建检查后删除 exception。 |
| `info-tooltip-20px` | S1 | 156 | 正式尺寸；内建检查后删除 exception。 |
| `table-heading-controls-zero-padding` | S2 | 212 | 修共享表头按钮后删除 exception。 |
| `info-tooltip-zero-padding` | S2 | 156 | 随 InfoTooltip 正式尺寸检查一并删除 exception。 |

`spacing-baseline.json` 保持空。任何后续 PR 不得增加 exception 或 baseline，也不得改变本清单阈值；确需扩大范围时另行向 Lead/用户申请。

## 可复核产物

完整机器报告与 108 张视口截图保存在本地忽略目录 `packages/ui/.shots-v085-audit/`，不纳入 Git。报告文件为 `report.json`；截图命名包含页面、CSS 视口和设备缩放倍率。审计使用的一次性临时脚本未纳入 Git，运行后已删除。
