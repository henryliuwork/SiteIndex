# {{brand_name}} · Agent 工作手册

进入本目录工作的 agent 必须遵守本文件。项目是什么、目录在哪见 `README.md`。
带 `siteindex:auto` 标记的区块由 SiteIndex 维护，不要修改。**不要直接编辑本文件的其他部分**：需要新增或修改约定时，把提案写进 `_outputs/agents-md-proposals.md`（每条带日期、理由、建议的位置），由用户确认后合并。

## 一、先读什么

1. `README.md`：项目概况与目录地图。
2. 本文件。
3. 做具体任务前，读对应板块目录里的 `README.md`。
4. 站点事实（SKU、价格、库存、URL、分类、博客清单、设计规范）**先读数据层**，见下方「数据指南」；数据缺失或冲突时如实说明，不要凭记忆或临时爬站给结论。

<!-- siteindex:auto:start id="agents-core" -->
<!-- siteindex:auto:end id="agents-core" -->

## 二、两条基本原则

1. **板块目录只放产物**：每个板块固定少量子目录，需要分组时按当期需要临时建。
2. **agent 要读的数据一律在 `_site-index/`**：它由 SiteIndex 维护，agent 只读；需要写入的台账只能通过 `siteindex ledger upsert`（或 MCP 的写入工具），不要直接编辑数据文件。

## 三、落盘与审核

1. 产物命名：`YYYY-MM-DD-<主题>.<状态后缀>.<扩展名>`；主题用英文小写连字符。
2. 待审产物先放 `_outputs/`；用户审完移到对应板块。板块目录里的文件视为已通过的现行版本。`_outputs/` 里的项处理完必须移走，空目录 = 没有待办。
3. 状态后缀只表达渠道自身进度：`-draft` / `-ready` / `-scheduled` / `-sent` / `-published`。例外：EDM 邮件成品留在 `04-edm/emails/` 内就地改名，不进 `_outputs/`。
4. 改文件前先读。**不做删除**：需要下线的内容移入 `_archive/`，只进不改。
5. 批量改写、格式转换一律生成副本，不覆盖原始数据与素材。
6. `_tmp/` 放中间文件，可随时清空。

## 四、硬边界

- 不可逆动作不自动执行：发送、排期、商品上下架、改价改库存、促销生效、退款、对外发送消息——只做到草稿或方案，交用户确认后执行。
- 写入类操作（发布、更新内容、排期）不以接口返回成功为准，必须回读核对。
- 商品参数、材质、认证、价格、数据结论必须有来源；未知项写「待补充」，不编造。正文出现具体百分比或统计时注明来源。
- **不要读取、复制、输出 `.env`**。凭据只由 SiteIndex 读取。
- 不要修改 `_site-index/` 内由 SiteIndex 维护的文件；不要把凭据、密钥写进任何文件或对话。

## 五、文件编码

- 所有文本文件使用 UTF-8。
- Windows 下 PowerShell 的默认编码会写坏中文与符号：写文件用编辑工具或明确指定 UTF-8，不要用 `Set-Content` 直接输出中文内容。
- 控制台输出中文可能乱码：需要核对完整输出时重定向到 `_tmp/` 文件再读。

<!-- siteindex:auto:start id="task-routing" -->
<!-- siteindex:auto:end id="task-routing" -->

<!-- siteindex:auto:start id="data-guide" -->
<!-- siteindex:auto:end id="data-guide" -->

<!-- siteindex:auto:start id="design-summary" -->
<!-- siteindex:auto:end id="design-summary" -->

<!-- siteindex:auto:start id="skills-installed" -->
<!-- siteindex:auto:end id="skills-installed" -->

<!-- siteindex:auto:start id="esp-presets" -->
<!-- siteindex:auto:end id="esp-presets" -->

## 项目约定与变更记录（用户确认后追加）
<!-- 每条：日期 · 约定内容 · 来源（用户口头 / agent 提案已确认） -->
