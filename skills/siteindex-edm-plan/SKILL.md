---
name: siteindex-edm-plan
version: 1.0.0
description: 规划 EDM 活动计划。所有路径从 workspace.json 的逻辑键读取。
reads:
  - _site-index/workspace.json
  - edm.sku_index
  - edm.profile
writes:
  - ledgers/edm_campaigns
---

# siteindex-edm-plan

## 数据目录与路径

- 首先读取 `_site-index/workspace.json`。所有板块和 EDM 文件路径必须按其中的逻辑键解析，不得硬编码目录名或根据旧项目习惯推断位置。
- 商品清单使用 `edm.sku_index`；运行配置使用 `edm.profile`；邮件模板、策略和成品目录分别使用 `edm.templates`、`edm.strategy`、`edm.emails`。
- 无法读取映射或配置缺失时先询问用户，不创建猜测的目录。
- 缺少必要运行参数时先向用户提问，并将用户确认的信息写入 `edm.profile` 对应文件。
- 外部邮件服务和连接信息一律视为项目配置项；不记录账号、连接标识或受众 ID。
- 运行结果写入 `ledgers/edm_campaigns` 台账；不得改写自动导出的 SKU 清单。

一个技能承担规划侧的全部工作：策略规范（发什么类型、多久发、什么时候发）、具体时间段的 campaign 计划（发哪几封、推哪些品、主题行怎么写）、以及 ESP 历史表现同步与分析（为前两者提供数据依据）。
**不做**：不制作 HTML、不操作 ESP 的写接口。成品邮件交给 `邮件或平台服务-edm-build`，推送草稿交给 `邮件或平台服务-edm-mc-send`。
## 第 0 步（强制）：读项目配置
任何模式开始前，先定位并读取 EDM 运行配置文件：
```
<project root>/_site-index/edm/edm-profile.md
```
里面必须能拿到：站点域名与 SKU 形态、分类页 URL 表、品牌名、ESP 平台与受众 list_id、连接标识、字体/色值、UTM 约定、目录路径约定、邮件类型定义。
- 文件不存在 → **停下来**，向用户要这些值并生成该文件，不要凭记忆或猜测填充，也不要用其他项目的配置。
- 文件存在但某些字段为空 → 只就缺的字段提问，其余照常推进。
- 品牌叙述类事实（定位、人群、卖点边界、合规红线）不在这份配置里，去配置指向的品牌档案读（通常是 `workspace.json 的逻辑路径`）。两份冲突时以品牌档案为准，并回改配置里的引用。
下文所有 `{...}` 占位都指代该配置文件中的值。
## 模式判定
| 用户意图 | 模式 |
|---|---|
| 定/改邮件规范、频率、类型定义 | **A. Strategy** |
| 做某时间段的具体 campaign 计划 | **B. Planning** |
| 拉 ESP 数据、看表现、哪些主题有效 | **C. Sync & Analyze** |
模式 C 是 A 和 B 的数据来源。B 发现没有历史数据时，先建议跑 C（没有历史数据也能出计划，但要告诉用户这版是"无数据依据"的）。
---
# 模式 A — Strategy（邮件营销策略）
产出 `workspace.json` 中的逻辑路径。这是 B 的输入规则。
## A1. 检查已有策略
存在 → 读出来给用户看，问要调整哪部分（用 `edit` 增量改，保留历史与 Change Log，升版本号）。
不存在 → 按 A2 从头收集。
## A2. 收集（新建时逐项问，不要一次甩六个问题）
1. **发送频率**：每周/每月几封
2. **邮件类型**：Educational / Promotional / Welcome / Abandoned Cart / Win-back / VIP …
3. **发送时间与星期**：哪几天、几点、什么时区
4. **每类的内容结构**：分几个区块
5. **折扣策略**：什么时候给折扣、给多少、优惠码规则
6. **目标**：营收 / 互动 / 留存
## A3. 有历史数据时先复盘再定策略
读 `{history_file}`（模式 C 产出）。**按邮件类型分开**看：各类型的打开率/点击率/退订率均值与趋势、同类内表现最好与最差的主题特征。然后问用户："基于这些数据，你想调整哪些策略？"
## A4. 输出结构
```markdown
# {品牌名} Email Campaign Strategy
> Created: `{sku}`
> Last updated: `{sku}`
> Version: X.X
## 推送频率
- Weekly: X emails
- Fixed days: [Day1 Type] + [Day2 Type]
- Send time: HH:MM [Timezone]
- Exceptions: (holidays, special events)
## 邮件类型定义
### {类型名}
- **目的** / **发送日** / **内容结构**（区块 1..N）
- **折扣策略** / **CTA 方向** / **退出条件**
## 季节性节奏
| Month | Key Events | Strategy Focus | Email Types | Discount Level |
## 内容选题
### Educational Topics（季节指南 / how-to / 产品知识 / 行业趋势）
### Promotional Themes（新品 / 畅销聚焦 / 季节促销 / 清仓）
## 品类邮件营销趋势
（行业基准打开率、点击率、高转化内容类型 — 有来源才写，注明来源与时间）
## 折扣策略
- Standard / Maximum(hard cap) / Code format / 何时加码
## 优化记录
| Date | Change | Reason | Result |
```
规则：**永不整份覆盖**，用 edit 增量改；显著变更升版本。
---
# 模式 B — Planning（某时间段 campaign 计划）
产出 `{planner_file}`（如 `workspace.json` 中的逻辑路径）。
## B1. 输入
向用户拿 `date_range`（如 `2026-11` 或 `workspace.json` 中的逻辑路径）。然后读四份：策略、商品清单（`{sku_index_path}`）、历史表现（若有）、品牌档案。
已有旧计划 → 先展示，问用户是新周期新建还是更新本期。
## B2. 排日历
按策略的频率与固定星期铺开该周期发送日，每格绑定类型；检查期间节日/活动并相应调整。
```
示例（策略=周三 Edu + 周六 Promo）
Week 1: 11/04 (Wed Edu) + 11/07 (Sat Promo)
```
## B3. 选品（每封）
1. **只选在库**商品（读 `{sku_index_path}` 的库存状态；权威口径以站点索引为准）
2. **避开近期用过的 SKU** — 查商品清单里的 `Email History` 字段（模式 C 回写）
3. 匹配当季相关性
4. 同等条件下优先评价数多的
5. Promo 每封 2–4 个产品；Edu 每封 1–2 个软提及
6. 推荐品缺货时，同品类内替换并说明理由
## B4. 逐封生成细节
- **Theme**：一句话主题
- **Subject Line**：3 个选项（A 主推 / B 备选 / C 好奇心角度），目标 **35–50 字符**（移动端不截断），硬上限 70；带折扣时把折扣写进主题
- **Preview Text**：40–90 字符，**补全而不重复** subject 的信息；有优惠码写明码与截止语义
- **Content Outline**：逐区块描述
- **Recommended Products**：SKU + 价格 + 折后价 + 选用理由
- **CTA**：主/次文案与目标分类页（从配置的分类 URL 表按主题选，hero 与 footer 同一个）
主题行与预览里**不得出现文件/配置里没有的数字**：折扣、价格、库存、运费、认证、时效一律要有依据。避免全大写堆砌、多个感叹号、spam 词。
## B5. 输出结构
```markdown
# {YYYY-MM} Campaign Plan
> Generated: `{sku}`
> Period: `{sku}` ~ `{sku}`
> Total campaigns: X (X Edu + X Promo)
## Schedule Overview
| # | Date | Day | Type | Theme |
---
## Campaign #01 — {Theme}
- **Date** / **Type** / **Send time**
### Subject Line Options
| Option | Subject | Chars |
### Preview Text
### Content Outline
1. ...
### Recommended Products
| SKU | Name | Price | Discount Price | Reason |
### CTA
- Primary: "{文案}" → {分类页 URL}
- Secondary: "{文案}" → {URL}
---
## Selection Rationale
（选品依据；本期避开的历史 SKU）
## Notes for Editor
（品牌主色、优惠码、给 build 阶段的特殊指示）
```
新周期出新生成；旧计划归档不删；用户可指定重出某一封。
---
# 模式 C — Sync & Analyze（ESP 历史表现）
## C1. 拉取
从配置取 ESP 平台、connection、受众 list_id，按平台走 API。
**邮件或平台服务**（经 `mcp__maton__api` 透传；懒加载模式下先取 schema 再调用）：
```
GET /邮件或平台服务/3.0/campaigns?count=100&status=sent&sort_field=send_time&sort_dir=desc
  （列表查询带 exclude_fields=content,report_summary,total_sent_to，别把正文读进上下文）
GET /邮件或平台服务/3.0/reports/{campaign_id}
  → emails_sent, opens.unique_accounts/open_rate, clicks.unique_accounts/click_rate,
    unsubscribes, hard_bounces, soft_bounces, send_time, settings.subject_line, list_id/list_name
```
- **必须按受众 list_id 过滤**，多品牌账号下混入他人数据会污染分析。
- `revenue` 邮件或平台服务 报表里常为 `null`，没有就别写成 0。
**邮件或平台服务** 等其他 ESP：按其 campaign 列表 + 单 campaign 指标接口对应实现。
## C2. 增量写入
读已有 `{raw_data_file}`，记 last_updated 与已存在的 campaign id。
| 情况 | 动作 |
|---|---|
| 新 campaign | 追加 |
| 已存在且任一指标变了 | 更新并记录变化 |
| 已存在且无变化 | 跳过，不碰 |
| ESP 已删除 | 本地保留，标注 `deleted in ESP` |
原始指标写 `{raw_data_file}`（`workspace.json` 中的逻辑路径），人读报告写 `{history_file}`（`workspace.json` 中的逻辑路径）。
**数据新鲜度**：发送后指标会持续变化最多 7 天（延迟打开/点击）。建议 Day 0 初值、Day 1、Day 3、Day 7 定稿。报告里注明每条数据的取数时间。
## C4. 分析铁律：按邮件类型分开
**促销邮件的打开率和点击率天然高于 educational**。把两类混在一张榜单上排"表现最好的 campaign"，得到的结论一定是"多发自带折扣的促销"——这是同义反复，不是洞察。
因此：
1. **分组统计**：Promo 与 Edu 各自算均值（打开率/点击率/退订率/送达量加权）、各自排榜。
2. **同类内对比才叫趋势**：想说"主题行带数字更有效"，必须在**同一类型内**比较，否则类型差异会冒充文案差异。
3. **退订率单独看**：促销常打开率漂亮但退订也高。要并排给出，不能只报打开率就推荐加密促销。
4. **送达量不是效果**：受众规模变化（新订阅、清洗）会改变分母，跨期比较优先用比率并标注 `emails_sent`。
5. **样本量小时不下结论**：某类型当期只有 2–3 封，说"仅供参考"，不说"数据表明"。
6. **混淆因素要标注**：季节性、发送时段、节日、受众变动都会影响结果，指出而非归因给单一变量。
结论必须写成**可执行且带依据**的形式，例如：
> Promo（n=8）打开率均值 42.1%，Edu（n=7）28.6% — 这是类型差异，不用于跨类比较。
> Promo 内部：主题含具体折扣数字的 5 封均值 46.3% vs 不含的 3 封 35.2% → 下期 Promo 主题保留折扣数字。
> Edu 退订均值 0.21% 低于 Promo 0.44%，Edu 仍是维持活跃度的低成本手段，不建议因 Promo 打开率高而砍掉 Edu。
## C5. 报告结构
```markdown

## 数据与安全边界

- SKU、商品名、价格、库存、图片 URL、受众与连接标识必须来自当前项目数据或用户明确提供；不得编造、借用其他项目的数据或写入示例真值。
- 凭据由 SiteIndex 或用户配置读取；不要请求、复制、记录或输出密码、密钥、受众 ID、连接 ID。
- 创建草稿和改写台账前先读取现有内容；写入后回读核对。没有用户明确授权时不排期、不发送。
