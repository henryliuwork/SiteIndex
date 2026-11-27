# v0.9.0 表格 UI 冻结清单

本清单用于 G9.0-0；基线为 `f4481e8`。B/D 按路线图 §3.5 在 1280×800@1、1920×1080@1、1536×864@1.25、1280×720@1.5 检查全部含表路由。当前冻结 **2 项**（上限 15）；冻结后不追加本版样式项。

| ID | 页面与可复现现象 | 本版验收口径 | 证据 |
|---|---|---|---|
| U9-1 | EDM 工具栏两个相邻说明图标没有可辨认的控件归属；「仅展示父 SKU」仍为原生复选框。 | 说明图标与对应筛选控件建立清晰关联；父 SKU 筛选使用共享 `FilterCheckbox`；四视口无控件贴边、遮挡或横向滚动。 | [D 审计与收敛记录](https://github.com/henryliuwork/SiteIndex/issues/869#issuecomment-7209049494)；Windows mock 截图 `edm-1536x864@1.25.png`、`edm-1280x720@1.5.png`（`packages/ui/.shots/`，未提交仓库）。 |
| U9-2 | SEO 页在 1280×720@1.5 的搜索占位文字末尾被截断。 | 占位文案与搜索框宽度匹配，用户可辨认搜索范围；四视口无遮挡或横向滚动。 | [D 审计与收敛记录](https://github.com/henryliuwork/SiteIndex/issues/869#issuecomment-7209049494)；Windows mock 截图 `seo-1536x864@1.25.png`、`seo-1280x720@1.5.png`（`packages/ui/.shots/`，未提交仓库）。 |

EDM 排序标识归入 T7 功能审计，不占视觉清单。定时任务残列、SEO 筛选控件占行、产品名称列宽等候选没有确认的裁切或量化违例，本版不纳入。后续新发现的样式项进入 backlog，不改本清单。

基线检查：`pnpm --filter @siteindex/ui ui:check` 为 108/108 strict、0 UI 失败、0 新样式违规、0 时间告警；见 [B 测试证据 PR #870](https://github.com/henryliuwork/SiteIndex/pull/870)。
